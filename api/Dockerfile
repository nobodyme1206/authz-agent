FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY api/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock && useradd -u 10001 -m app && mkdir /snapshots /runs && chown app:app /snapshots /runs
COPY api/app ./app
COPY api/tests ./tests
COPY contracts /contracts
USER app
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
