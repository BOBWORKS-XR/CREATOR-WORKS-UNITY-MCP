use fs2::FileExt;
use std::{env, fs, io, path::Path, thread, time::{Duration, Instant}};

fn run(args: &[String]) -> io::Result<i32> {
    let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&args[2])?;
    if let Err(error) = lock.try_lock_exclusive() {
        return if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() { Ok(10) } else { Err(error) };
    }
    if args[1] == "hold" {
        fs::write(&args[3], b"locked")?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !Path::new(&args[4]).exists() {
            if Instant::now() >= deadline { return Ok(11); }
            thread::sleep(Duration::from_millis(20));
        }
    }
    FileExt::unlock(&lock)?;
    Ok(0)
}
fn main() {
    let args: Vec<String> = env::args().collect();
    if !((args.len() == 3 && args[1] == "try") || (args.len() == 5 && args[1] == "hold")) { std::process::exit(2); }
    match run(&args) {
        Ok(code) => std::process::exit(code),
        Err(error) => { eprintln!("{error}"); std::process::exit(12); }
    }
}
