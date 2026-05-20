use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

pub struct PtyInstance {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
}

/// Get the full PATH from the user's login shell
fn get_shell_path() -> String {
    // Try to get PATH from login shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if let Ok(output) = std::process::Command::new(&shell)
        .args(["-l", "-c", "echo $PATH"])
        .output()
    {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return path;
        }
    }
    // Fallback: current env PATH + common paths
    let current = std::env::var("PATH").unwrap_or_default();
    format!(
        "/opt/homebrew/bin:/usr/local/bin:{}",
        current
    )
}

/// Properly escape a shell argument
fn shell_escape(s: &str) -> String {
    if s.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/') {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

pub struct PtyManager {
    instances: Arc<RwLock<HashMap<String, Arc<Mutex<PtyInstance>>>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Get a clone of the instance Arc without holding the map lock
    fn get_instance(&self, id: &str) -> Result<Arc<Mutex<PtyInstance>>, String> {
        let map = self.instances.read().map_err(|e| format!("Lock error: {}", e))?;
        map.get(id)
            .cloned()
            .ok_or_else(|| format!("PTY not found: {}", id))
    }

    pub fn spawn_shell(
        &self,
        id: &str,
        cwd: Option<&str>,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl Fn() + Send + 'static,
    ) -> Result<(), String> {
        // If this ID already exists, close it first (handles re-mount)
        {
            let mut map = self.instances.write().map_err(|e| e.to_string())?;
            if map.contains_key(id) {
                map.remove(id);
                drop(map);
                thread::sleep(std::time::Duration::from_millis(100));
            }
        }

        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let home = dirs::home_dir().unwrap_or_default().to_string_lossy().to_string();
        let path = get_shell_path();
        
        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(["-l", "-i"]);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_string()));
        cmd.env("PATH", &path);
        cmd.env("HOME", &home);
        if let Some(dir) = cwd {
            if std::path::Path::new(dir).exists() {
                cmd.cwd(dir);
            }
        }

        let _child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get writer: {}", e))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get reader: {}", e))?;

        thread::spawn(move || {
            let mut buf = [0u8; 32768];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        on_output(buf[..n].to_vec());
                    }
                    Err(_) => break,
                }
            }
            on_exit();
        });

        let instance = PtyInstance {
            master: pair.master,
            writer,
        };

        let mut map = self.instances.write().map_err(|e| e.to_string())?;
        map.insert(id.to_string(), Arc::new(Mutex::new(instance)));

        Ok(())
    }

    pub fn spawn_command(
        &self,
        id: &str,
        program: &str,
        args: &[String],
        cwd: Option<&str>,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl Fn() + Send + 'static,
    ) -> Result<(), String> {
        // If this ID already exists, close it first (handles React StrictMode re-mount)
        {
            let mut map = self.instances.write().map_err(|e| e.to_string())?;
            map.remove(id);
        }

        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        // Run the command inside a login shell (NOT interactive) so PATH is resolved
        // but the shell doesn't compete with the TUI for terminal control
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let full_command = if args.is_empty() {
            program.to_string()
        } else {
            format!("{} {}", program, args.iter()
                .map(|a| shell_escape(a))
                .collect::<Vec<_>>()
                .join(" "))
        };

        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(["-l", "-c", &full_command]);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_string()));
        cmd.env("PATH", get_shell_path());
        cmd.env("HOME", dirs::home_dir().unwrap_or_default().to_string_lossy().to_string());
        if let Some(dir) = cwd {
            if std::path::Path::new(dir).exists() {
                cmd.cwd(dir);
            }
        }

        let _child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;

        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get writer: {}", e))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get reader: {}", e))?;

        thread::spawn(move || {
            let mut buf = [0u8; 32768];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        on_output(buf[..n].to_vec());
                    }
                    Err(_) => break,
                }
            }
            on_exit();
        });

        let instance = PtyInstance {
            master: pair.master,
            writer,
        };

        let mut map = self.instances.write().map_err(|e| e.to_string())?;
        map.insert(id.to_string(), Arc::new(Mutex::new(instance)));

        Ok(())
    }

    /// Write to PTY — only locks the specific instance, not the whole manager
    pub fn write_to_pty(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let instance = self.get_instance(id)?;
        let mut inst = instance.lock().map_err(|e| format!("Lock error: {}", e))?;
        inst.writer
            .write_all(data)
            .map_err(|e| format!("Write error: {}", e))?;
        // No flush needed — PTY pipes don't buffer like files
        Ok(())
    }

    pub fn resize_pty(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let instance = self.get_instance(id)?;
        let inst = instance.lock().map_err(|e| format!("Lock error: {}", e))?;
        inst.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize error: {}", e))?;

        Ok(())
    }

    pub fn close_pty(&self, id: &str) {
        if let Ok(mut map) = self.instances.write() {
            map.remove(id);
        }
    }
}
