// Native acceptance fixture: about:blank, unique app identity, no plugins,
// configuration handlers, scene discovery, installed files or client shutdown.
#[path = "../src/lifecycle.rs"]
mod lifecycle;

#[cfg(windows)]
fn main() {
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    use windows_sys::core::w;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetPropW, IsWindow, SendMessageTimeoutW, SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_CLOSE,
    };

    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "com.creatorworks.lifecycle-smoke".into();
    context.config_mut().app.windows.clear();
    let data =
        std::env::temp_dir().join(format!("creator-lifecycle-smoke-{}", uuid::Uuid::new_v4()));
    let result = Arc::new(Mutex::new(None::<Result<(), String>>));
    let output = Arc::clone(&result);
    let app = tauri::Builder::default()
        .on_window_event(lifecycle::window_event)
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External("about:blank".parse()?),
            )
            .visible(false)
            .data_directory(data)
            .build()?;
            let hwnd = window.hwnd()?.0 as usize;
            lifecycle::LIFECYCLE.attach_window(hwnd);
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let workflow = lifecycle::LIFECYCLE.begin_workflow().unwrap();
                let attempted = (|| -> Result<(), String> {
                    let flush = || -> Result<(), String> {
                        let (send, receive) = mpsc::sync_channel(1);
                        handle
                            .run_on_main_thread(move || {
                                let _ = send.send(());
                            })
                            .map_err(|e| e.to_string())?;
                        receive
                            .recv_timeout(Duration::from_secs(5))
                            .map_err(|e| e.to_string())
                    };
                    flush()?;
                    unsafe {
                        if GetPropW(hwnd as _, w!("CreatorSuite.LifecycleProtocol")) as usize != 1
                            || GetPropW(hwnd as _, w!("CreatorSuite.LauncherBusy")) as usize != 1
                        {
                            return Err("Native busy/protocol property missing".into());
                        }
                        if SendMessageTimeoutW(
                            hwnd as _,
                            WM_CLOSE,
                            0,
                            0,
                            SMTO_ABORTIFHUNG | SMTO_BLOCK,
                            3000,
                            std::ptr::null_mut(),
                        ) == 0
                        {
                            return Err("WM_CLOSE did not respond".into());
                        }
                    }
                    flush()?;
                    if unsafe { IsWindow(hwnd as _) } == 0 {
                        return Err("Busy WM_CLOSE destroyed the window".into());
                    }
                    handle.exit(0);
                    flush()?;
                    if unsafe { IsWindow(hwnd as _) } == 0 {
                        return Err("Busy exit destroyed the window".into());
                    }
                    lifecycle::LIFECYCLE
                        .finish_workflow(workflow)
                        .map_err(str::to_owned)?;
                    let command = lifecycle::LIFECYCLE.command().map_err(str::to_owned)?;
                    unsafe {
                        SendMessageTimeoutW(
                            hwnd as _,
                            WM_CLOSE,
                            0,
                            0,
                            SMTO_ABORTIFHUNG | SMTO_BLOCK,
                            3000,
                            std::ptr::null_mut(),
                        );
                    }
                    flush()?;
                    if unsafe { IsWindow(hwnd as _) } == 0 {
                        return Err("Busy command did not protect WM_CLOSE".into());
                    }
                    drop(command);
                    Ok(())
                })();
                let failed = attempted.is_err();
                *output.lock().unwrap() = Some(attempted);
                // Cleanup only this fixture. No process termination API or PID lookup.
                let _ = lifecycle::LIFECYCLE.finish_workflow(workflow);
                if failed {
                    handle.exit(1);
                } else {
                    unsafe {
                        SendMessageTimeoutW(
                            hwnd as _,
                            WM_CLOSE,
                            0,
                            0,
                            SMTO_ABORTIFHUNG | SMTO_BLOCK,
                            3000,
                            std::ptr::null_mut(),
                        );
                    }
                }
            });
            Ok(())
        })
        .build(context)
        .expect("build isolated lifecycle fixture");
    let code = app.run_return(lifecycle::run_event);
    let outcome = result.lock().unwrap().take();
    match outcome {
        Some(Ok(())) if code == 0 => println!("{{\"success\":true,\"busyWindowCloseRefused\":true,\"busyExitRefused\":true,\"commandCloseRefused\":true,\"idleWindowCloseExited\":true,\"fixture\":\"isolated Tauri about:blank with production lifecycle hooks\"}}"),
        other => { eprintln!("Native lifecycle fixture failed: {other:?}, exit {code}"); std::process::exit(1); }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows-only native lifecycle fixture");
    std::process::exit(2);
}
