"""Credential-local, fixed-host Inworld gateway. No credentials enter stdout."""
from __future__ import annotations

import http.client
import json
import os
import sys


def main() -> None:
    value: dict[str, object] = json.load(sys.stdin)
    path = value.get('path')
    method = value.get('method')
    if not isinstance(path, str) or not path.startswith(('/tts/v1/', '/voices/v1/', '/lro/v1alpha/')):
        raise ValueError('Unsupported endpoint')
    if method not in ('GET', 'POST'):
        raise ValueError('Unsupported method')
    body = json.dumps(value['body']).encode() if 'body' in value else None
    connection = http.client.HTTPSConnection('api.inworld.ai', timeout=180)
    try:
        connection.request(str(method), path, body, {'Authorization': 'Basic ' + os.environ['INWORLD_API_KEY'],
                                                    'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = json.loads(response.read())
        print(json.dumps({'status': response.status, 'body': data}))
    finally:
        connection.close()


if __name__ == '__main__':
    main()
