import os,tempfile
from pathlib import Path
from urllib.parse import quote
ROOT=Path(tempfile.mkdtemp(prefix='authz-api-test-'))
for name in ('sources','snapshots','runs','contracts'):(ROOT/name).mkdir()
(ROOT/'token').write_text('test-internal-token')
database='sqlite:///'+str(ROOT/'db.sqlite')
if os.getenv('AUTHZ_TEST_POSTGRES')=='1':
    password=quote(Path(os.environ['DB_PASSWORD_FILE']).read_text().strip(),safe='')
    # Deliberately fixed test database: never drop tables in the production DB.
    database=f'postgresql+psycopg://authz:{password}@db:5432/authz_batch1_test'
os.environ.update(DATABASE_URL=database,SOURCE_ROOT=str(ROOT/'sources'),SNAPSHOT_ROOT=str(ROOT/'snapshots'),RUN_ROOT=str(ROOT/'runs'),INTERNAL_TOKEN_FILE=str(ROOT/'token'),CONTRACT_ROOT='/contracts')
