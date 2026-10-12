# Initial API

- `GET /health`
- `POST /api/audit` `{ "url": "https://example.com" }`
- `POST /api/compare` `{ "oldUrl": "https://old.example.com/", "newUrl": "https://new.example.com/" }`
- `POST /api/import/csv` `{ "csv": "url\\nhttps://example.com/" }`
- `POST /api/export/xlsx` `{ "results": [] }`

This is a development API. Do not expose it publicly until authentication, request quotas, robust connection-time SSRF protection, job isolation and result validation are implemented.
