"""Explicit, additive migration from the batch-one database; never recreates data."""
from sqlalchemy import inspect, text

VERSION = '0002_stage1'


def upgrade(engine):
    with engine.begin() as connection:
        if engine.dialect.name == 'postgresql':
            connection.execute(text('SELECT pg_advisory_xact_lock(80241002)'))
        inspector = inspect(connection)
        if 'jobs' in inspector.get_table_names():
            names = {c['name'] for c in inspector.get_columns('jobs')}
            if 'options' not in names:
                connection.execute(text("ALTER TABLE jobs ADD COLUMN options JSON NOT NULL DEFAULT '{}'"))
        connection.execute(text('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR PRIMARY KEY)'))
        connection.execute(text('INSERT INTO schema_migrations(version) VALUES (:version) ON CONFLICT(version) DO NOTHING'), {'version': VERSION})
    # New tables only. Existing tables and rows are preserved by create_all.
    from .db import Base
    Base.metadata.create_all(engine)
