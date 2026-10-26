# WagVitals cloud API

A tiny, dependency-free Node.js service that receives the app's per-minute
summaries. Deploy it with your **student cloud credits** (Google Cloud, Azure
for Students, AWS Educate) or run it locally.

## What gets uploaded (and why it's cheap)

Raw sensor data (25+ readings per second) never leaves the device. The app
uploads **one summary per minute**: time per activity, heart-rate
avg/min/max, resting baseline, temperature, breathing, battery, gait and any
alerts raised. A summary is roughly 400 bytes, so one dog produces about
1,440 summaries (≈ 0.6 MB) per day. That fits easily in free tiers and costs
little in credits. Summaries are queued on the device while offline and sent
later.

## API

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| `POST` | `/v1/summaries` | `{"deviceId": "...", "summaries": [ ... ]}` | `{"accepted": n, "rejected": n}` |
| `GET` | `/v1/summaries` | `?deviceId=...&limit=100` | `{"summaries": [ ... ]}` |
| `GET` | `/healthz` | | `{"ok": true, "records": n}` |

Send `Authorization: Bearer <API_KEY>` when the server has `API_KEY` set.

## Run locally

```bash
API_KEY=dev-key npm run cloud        # from the repository root, port 8080
```

In the app: **Settings → Cloud sync**, tick *Upload one summary per minute*,
endpoint `http://localhost:8080`, API key `dev-key`.

## Deploy to Google Cloud Run (Google Cloud credits)

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud run deploy wagvitals-api --source cloud --region us-central1 \
  --allow-unauthenticated --set-env-vars API_KEY=$(openssl rand -hex 16)
```

The command prints the service URL. Put it and the API key into the app's
settings. (`--allow-unauthenticated` lets the app reach the URL. The API key
still protects the data.)

## Deploy to Azure (Azure for Students credits)

```bash
az login
az containerapp up --name wagvitals-api --resource-group wagvitals \
  --location eastus --source cloud --ingress external --target-port 8080 \
  --env-vars API_KEY=$(openssl rand -hex 16)
```

AWS works too (App Runner or Elastic Beanstalk from the `cloud/Dockerfile`).

## Before real users

- **Storage:** this reference server writes newline-delimited JSON to a local
  file. Cloud Run and Container Apps disks are temporary, so data is lost on
  redeploy. Swap `appendRecords()` / `loadRecords()` in `server.js` for
  Firestore, Cosmos DB or DynamoDB.
- **Keys:** never commit API keys. Use the platform's secret manager.
- **Accounts:** one shared API key is fine for a prototype; real users need
  per-owner sign-in (e.g. Firebase Auth) before storing health data.
