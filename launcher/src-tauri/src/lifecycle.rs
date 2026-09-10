use std::sync::Mutex;

pub static LIFECYCLE: Lifecycle = Lifecycle::new();

pub fn window_event(window: &tauri::Window<tauri::Wry>, event: &tauri::WindowEvent) {
    use tauri::Emitter;
    if window.label() != "main" {
        return;
    }
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if !LIFECYCLE.request_close() {
                api.prevent_close();
                let _ = window.emit("creator-lifecycle-close-blocked", ());
            }
        }
        tauri::WindowEvent::Destroyed => LIFECYCLE.detach_window(),
        _ => {}
    }
}

pub fn run_event(_: &tauri::AppHandle<tauri::Wry>, event: tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested { api, .. } = event {
        if !LIFECYCLE.request_close() {
            api.prevent_exit();
        }
    }
}

struct State {
    commands: u32,
    workflow: Option<u32>,
    next_workflow: u32,
    closing: bool,
    window: Option<usize>,
}

pub struct Lifecycle(Mutex<State>);

pub struct CommandGuard<'a>(&'a Lifecycle);

impl Lifecycle {
    pub const fn new() -> Self {
        Self(Mutex::new(State {
            commands: 0,
            workflow: None,
            next_workflow: 0,
            closing: false,
            window: None,
        }))
    }

    // Command guards cover the current synchronous Tauri handlers. Workflows
    // additionally cover gaps between invokes, including native file pickers.
    pub fn command(&self) -> Result<CommandGuard<'_>, &'static str> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Launcher lifecycle unavailable")?;
        if state.closing {
            return Err("Launcher is closing; new operations are disabled");
        }
        state.commands = state.commands.checked_add(1).ok_or("Too many operations")?;
        state.publish();
        Ok(CommandGuard(self))
    }

    pub fn begin_workflow(&self) -> Result<u32, &'static str> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Launcher lifecycle unavailable")?;
        if state.closing || state.workflow.is_some() {
            return Err("Launcher is closing or another operation is active");
        }
        let id = state
            .next_workflow
            .checked_add(1)
            .ok_or("Operation IDs exhausted")?;
        state.next_workflow = id;
        state.workflow = Some(id);
        state.publish();
        Ok(id)
    }

    pub fn finish_workflow(&self, id: u32) -> Result<(), &'static str> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Launcher lifecycle unavailable")?;
        if state.workflow != Some(id) {
            return Err("Operation receipt does not match the active workflow");
        }
        state.workflow = None;
        state.publish();
        Ok(())
    }

    pub fn request_close(&self) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if state.commands != 0 || state.workflow.is_some() {
            return false;
        }
        state.closing = true;
        state.publish();
        true
    }

    #[cfg(windows)]
    pub fn attach_window(&self, window: usize) {
        if let Ok(mut state) = self.0.lock() {
            state.window = Some(window);
            state.publish();
        }
    }

    pub fn detach_window(&self) {
        if let Ok(mut state) = self.0.lock() {
            if let Some(window) = state.window.take() {
                clear_properties(window);
            }
        }
    }
}

impl State {
    fn publish(&self) {
        if let Some(window) = self.window {
            publish_properties(
                window,
                self.commands != 0 || self.workflow.is_some(),
                self.closing,
            );
        }
    }
}

impl Drop for CommandGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.commands -= 1;
            state.publish();
        }
    }
}

#[cfg(windows)]
fn publish_properties(window: usize, busy: bool, closing: bool) {
    use windows_sys::core::w;
    use windows_sys::Win32::UI::WindowsAndMessaging::{RemovePropW, SetPropW};
    let hwnd = window as _;
    // Only our window, constant integer values, no pointers to shared memory.
    // Properties are hints for verified callers, never update authorization.
    unsafe {
        if SetPropW(
            hwnd,
            w!("CreatorSuite.LauncherBusy"),
            usize::from(busy) as _,
        ) != 0
            && SetPropW(hwnd, w!("CreatorSuite.Closing"), usize::from(closing) as _) != 0
        {
            SetPropW(hwnd, w!("CreatorSuite.LifecycleProtocol"), 1usize as _);
        } else {
            RemovePropW(hwnd, w!("CreatorSuite.LifecycleProtocol"));
        }
    }
}

#[cfg(windows)]
fn clear_properties(window: usize) {
    use windows_sys::core::w;
    use windows_sys::Win32::UI::WindowsAndMessaging::RemovePropW;
    unsafe {
        for name in [
            w!("CreatorSuite.LifecycleProtocol"),
            w!("CreatorSuite.LauncherBusy"),
            w!("CreatorSuite.Closing"),
        ] {
            RemovePropW(window as _, name);
        }
    }
}

#[cfg(not(windows))]
fn publish_properties(_: usize, _: bool, _: bool) {}

#[cfg(not(windows))]
fn clear_properties(_: usize) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn close_refuses_commands_and_workflows_including_gaps() {
        let life = Lifecycle::new();
        let workflow = life.begin_workflow().unwrap();
        let command = life.command().unwrap();
        assert!(!life.request_close());
        drop(command);
        assert!(!life.request_close());
        assert!(life.begin_workflow().is_err());
        assert!(life.finish_workflow(workflow + 1).is_err());
        assert!(!life.request_close());
        life.finish_workflow(workflow).unwrap();
        assert!(life.finish_workflow(workflow).is_err());
        assert!(life.request_close());
        assert!(life.command().is_err());
        assert!(life.begin_workflow().is_err());
        assert!(life.request_close());
    }

    #[test]
    fn commands_remain_busy_until_last_guard_drops_even_on_error() {
        let life = Lifecycle::new();
        let first = life.command().unwrap();
        let second = life.command().unwrap();
        drop(first);
        assert!(!life.request_close());
        drop(second);
        assert!(life.request_close());
    }

    #[test]
    fn operation_and_close_race_have_only_one_winner() {
        for _ in 0..64 {
            let life = Arc::new(Lifecycle::new());
            let barrier = Arc::new(Barrier::new(2));
            let runner = {
                let life = Arc::clone(&life);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    life.begin_workflow()
                })
            };
            barrier.wait();
            let closed = life.request_close();
            let started = runner.join().unwrap();
            assert_ne!(closed, started.is_ok());
        }
    }

    #[test]
    fn poisoned_state_fails_closed() {
        let life = Lifecycle::new();
        let _ = std::panic::catch_unwind(|| {
            let _state = life.0.lock().unwrap();
            panic!("test fixture");
        });
        assert!(!life.request_close());
        assert!(life.command().is_err());
        assert!(life.begin_workflow().is_err());
    }

    #[cfg(windows)]
    #[test]
    fn window_properties_are_scoped_and_reflect_native_state() {
        use windows_sys::core::w;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetPropW,
        };
        unsafe {
            let window = CreateWindowExW(
                0,
                w!("STATIC"),
                w!("Lifecycle test fixture"),
                0,
                0,
                0,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!window.is_null());
            let life = Lifecycle::new();
            life.attach_window(window as usize);
            assert_eq!(
                GetPropW(window, w!("CreatorSuite.LifecycleProtocol")) as usize,
                1
            );
            assert_eq!(
                GetPropW(window, w!("CreatorSuite.LauncherBusy")) as usize,
                0
            );
            let command = life.command().unwrap();
            assert_eq!(
                GetPropW(window, w!("CreatorSuite.LauncherBusy")) as usize,
                1
            );
            drop(command);
            assert_eq!(
                GetPropW(window, w!("CreatorSuite.LauncherBusy")) as usize,
                0
            );
            assert!(life.request_close());
            assert_eq!(GetPropW(window, w!("CreatorSuite.Closing")) as usize, 1);
            life.detach_window();
            assert_eq!(
                GetPropW(window, w!("CreatorSuite.LifecycleProtocol")) as usize,
                0
            );
            assert_ne!(DestroyWindow(window), 0);
        }
    }
}
