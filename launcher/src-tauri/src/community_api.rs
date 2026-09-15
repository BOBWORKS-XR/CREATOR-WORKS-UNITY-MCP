//! Standalone-only adapters. Community operations never enter the hosted allowlist.
use crate::{community, community_project, lifecycle::LIFECYCLE};

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

#[tauri::command]
pub async fn community_projects(
    handle: tauri::AppHandle,
) -> Result<community_project::Targets, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _command = LIFECYCLE.command().map_err(str::to_owned)?;
        community_project::projects_worker(handle, Vec::new())
    })
    .await
    .map_err(|_| "Community project-list worker failed.".to_owned())?
}

#[tauri::command]
pub async fn choose_community_project(
    handle: tauri::AppHandle,
) -> Result<Option<community_project::Target>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _command = LIFECYCLE.command().map_err(str::to_owned)?;
        community_project::pick_worker(handle)
    })
    .await
    .map_err(|_| "Community project-picker worker failed.".to_owned())?
}

#[tauri::command]
pub async fn install_community_menu(
    handle: tauri::AppHandle,
    project_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _command = LIFECYCLE.command().map_err(str::to_owned)?;
        community_project::install_worker(handle, project_id)
    })
    .await
    .map_err(|_| "Community menu-install worker failed.".to_owned())?
}

#[tauri::command]
pub async fn queue_community_import(
    handle: tauri::AppHandle,
    id: String,
    project_id: String,
) -> Result<community_project::Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _command = LIFECYCLE.command().map_err(str::to_owned)?;
        community::queue_import_worker(handle, id, project_id)
    })
    .await
    .map_err(|_| "Community import-queue worker failed.".to_owned())?
}

#[tauri::command]
pub async fn community_import_status(
    handle: tauri::AppHandle,
    project_id: String,
    request_id: String,
) -> Result<community_project::Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _command = LIFECYCLE.command().map_err(str::to_owned)?;
        community_project::status_worker(handle, project_id, request_id)
    })
    .await
    .map_err(|_| "Community import-status worker failed.".to_owned())?
}
