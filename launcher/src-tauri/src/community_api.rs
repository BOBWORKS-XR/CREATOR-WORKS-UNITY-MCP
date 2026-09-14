//! Standalone-only adapters. Community operations never enter the hosted allowlist.
use crate::{community, lifecycle::LIFECYCLE};

#[tauri::command]
pub async fn community_catalogue(
    handle: tauri::AppHandle,
    refresh: bool,
) -> Result<community::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _command = LIFECYCLE.command().map_err(str::to_owned)?;
        community::catalogue_worker(handle, refresh)
    })
    .await
    .map_err(|_| "Community catalogue worker failed.".to_owned())?
}

#[tauri::command]
pub async fn download_community_package(
    handle: tauri::AppHandle,
    id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _command = LIFECYCLE.command().map_err(str::to_owned)?;
        community::download_worker(handle, id)
    })
    .await
    .map_err(|_| "Community download worker failed.".to_owned())?
}

#[tauri::command]
pub async fn open_community_link(
    handle: tauri::AppHandle,
    id: String,
    kind: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _command = LIFECYCLE.command().map_err(str::to_owned)?;
        community::open_link_worker(handle, id, kind)
    })
    .await
    .map_err(|_| "Community link worker failed.".to_owned())?
}
