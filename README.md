# Excalidraw Sync (EdgeOne)

Single-user Excalidraw with password login and multi-document cloud save (EdgeOne Blob).

## Deploy
See `/workspace/out/excalidraw-sync-eo-2026-10-18.md`.

## API
- `POST /api/login` `{password}`
- `POST /api/logout`
- `GET /api/me`
- `GET|POST /api/docs`
- `GET|PUT|PATCH|DELETE /api/docs/:id`
