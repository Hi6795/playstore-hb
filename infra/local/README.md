# Local infrastructure

Run `docker compose up --build`. PostgreSQL listens only inside the compose network; MinIO is exposed on 9000/9001; the API is on 8080 and admin UI on 5174. Every credential is development-only. Delete named volumes explicitly if a full local reset is desired; bootstrap never deletes them.
