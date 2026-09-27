mod scan;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![scan::scan_usage])
        .run(tauri::generate_context!())
        .expect("failed to start CostToken");
}
