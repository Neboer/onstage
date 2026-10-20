"""Export the actual request contract without opening documentation endpoints."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.main import create_app

if __name__ == '__main__':
    app = create_app(public_origin='http://localhost', version=(ROOT / 'VERSION').read_text().strip())
    target = ROOT / 'docs/openapi.json'
    target.write_text(json.dumps(app.openapi(), ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print('Exported actual API request schema: docs/openapi.json')
