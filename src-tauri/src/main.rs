#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn get_user_shell() -> String {
    // Most desktop sessions set $SHELL to the user's login shell
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() && std::path::Path::new(&shell).exists() {
            return shell;
        }
    }

    // Fallback: probe common shells
    let candidates = [
        "/usr/bin/fish",
        "/bin/fish",
        "/usr/local/bin/fish",
        "/usr/bin/zsh",
        "/bin/zsh",
        "/usr/local/bin/zsh",
        "/usr/bin/bash",
        "/bin/bash",
        "/bin/sh",
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.to_string();
        }
    }

    "/bin/sh".to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_user_shell])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
