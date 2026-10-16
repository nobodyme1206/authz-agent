import os
from pathlib import Path
from urllib.parse import quote
from datetime import datetime, timezone
from sqlalchemy import create_engine, String, Text, DateTime, JSON, Integer, ForeignKey
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

def now():
    return datetime.now(timezone.utc)

def secret(name, default=''):
    p = os.getenv(name)
    return Path(p).read_text().strip() if p and Path(p).is_file() else default

url = os.getenv('DATABASE_URL')
if not url:
    password = quote(secret('DB_PASSWORD_FILE'), safe='')
    url = f'postgresql+psycopg://authz:{password}@db:5432/authz'
engine = create_engine(url, pool_pre_ping=True, **({'connect_args': {'check_same_thread': False}} if url.startswith('sqlite') else {}))
Session = sessionmaker(engine, expire_on_commit=False)
class Base(DeclarativeBase): pass
class Project(Base):
    __tablename__ = 'projects'
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    source: Mapped[str] = mapped_column(String, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
class Snapshot(Base):
    __tablename__ = 'snapshots'
    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey('projects.id'))
    revision: Mapped[str] = mapped_column(String)
    files: Mapped[int] = mapped_column(Integer)
    size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
class Job(Base):
    __tablename__ = 'jobs'
    id: Mapped[str] = mapped_column(String, primary_key=True)
    snapshot_id: Mapped[str] = mapped_column(ForeignKey('snapshots.id'))
    kind: Mapped[str] = mapped_column(String, default='agent_probe')
    state: Mapped[str] = mapped_column(String, default='queued')
    file: Mapped[str] = mapped_column(String)
    worker: Mapped[str | None] = mapped_column(String, nullable=True)
    heartbeat: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
class Event(Base):
    __tablename__ = 'events'
    job_id: Mapped[str] = mapped_column(ForeignKey('jobs.id'), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String)
    data: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
class Worker(Base):
    __tablename__ = 'workers'
    key: Mapped[str] = mapped_column(String, primary_key=True)
    boot: Mapped[str] = mapped_column(String)
    seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    model: Mapped[dict] = mapped_column(JSON, default=dict)
