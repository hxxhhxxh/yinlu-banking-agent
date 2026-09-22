# -*- coding: utf-8 -*-
"""通过 GitHub API 推送/更新仓库内容（本机 github.com:443 不通，api.github.com 可用）。
用法：python scripts/push_via_api.py          # 全量推送（单提交，history 被压缩为一次）
      python scripts/push_via_api.py --file README.md   # 只更新单个文件（走 Contents API，快）
鉴权由 gh CLI 提供，脚本本身不接触 token。
"""
import base64
import json
import os
import subprocess
import sys

REPO = 'hxxhhxxh/yinshu-banking-agent'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, '.cowork-temp', '_gh_payload.json')
MSG = '银枢·AI银行副驾 v1.0：六大场景 + 安全门禁 + 309 项自动化断言（264+20+25）'


def gh_api(method, path, payload=None):
    cmd = ['gh', 'api', '--method', method, path, '-H', 'Accept: application/vnd.github+json']
    if payload is not None:
        os.makedirs(os.path.dirname(TMP), exist_ok=True)
        with open(TMP, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
        cmd += ['--input', TMP]
    out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if out.returncode != 0:
        raise RuntimeError('%s %s 失败：%s' % (method, path, (out.stderr or out.stdout)[:300]))
    return json.loads(out.stdout) if out.stdout.strip() else {}


def push_one(rel, message=None):
    """用 Contents API 更新单个文件（自动处理新建与已有 sha）"""
    with open(os.path.join(ROOT, rel), 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    body = {'message': message or ('update: ' + rel), 'content': b64, 'branch': 'main'}
    try:
        cur = gh_api('GET', '/repos/%s/contents/%s' % (REPO, rel))
        body['sha'] = cur['sha']
    except RuntimeError:
        pass
    r = gh_api('PUT', '/repos/%s/contents/%s' % (REPO, rel), body)
    print('已更新 %s → %s' % (rel, r['commit']['sha'][:10]))


def push_all():
    try:
        gh_api('GET', '/repos/%s/commits?per_page=1' % REPO)
        has_commit = True
    except RuntimeError:
        has_commit = False
    if not has_commit:
        gh_api('PUT', '/repos/%s/contents/.gitignore' % REPO, {
            'message': 'chore: init repository',
            'content': base64.b64encode(b'# placeholder\n').decode(), 'branch': 'main'})
        print('已创建初始提交（空仓库引导）')

    files = subprocess.run(['git', '-c', 'core.quotePath=false', 'ls-files'], cwd=ROOT,
                           capture_output=True, text=True, encoding='utf-8', errors='replace').stdout.split('\n')
    files = [f.strip() for f in files if f.strip()]
    print('待推送文件：%d 个' % len(files))

    entries = []
    for i, rel in enumerate(files, 1):
        with open(os.path.join(ROOT, rel), 'rb') as f:
            b64 = base64.b64encode(f.read()).decode()
        blob = gh_api('POST', '/repos/%s/git/blobs' % REPO, {'content': b64, 'encoding': 'base64'})
        entries.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
        if i % 10 == 0 or i == len(files):
            print('  已上传 %d/%d' % (i, len(files)))

    tree = gh_api('POST', '/repos/%s/git/trees' % REPO, {'tree': entries})
    commit = gh_api('POST', '/repos/%s/git/commits' % REPO, {'message': MSG, 'tree': tree['sha']})
    try:
        gh_api('POST', '/repos/%s/git/refs' % REPO, {'ref': 'refs/heads/main', 'sha': commit['sha']})
    except RuntimeError:
        gh_api('PATCH', '/repos/%s/git/refs/heads/main' % REPO, {'sha': commit['sha'], 'force': True})
    print('已推送：https://github.com/%s' % REPO)


if __name__ == '__main__':
    try:
        if '--file' in sys.argv:
            push_one(sys.argv[sys.argv.index('--file') + 1])
        else:
            push_all()
    except Exception as e:
        print('失败：', e)
        sys.exit(1)
    finally:
        if os.path.exists(TMP):
            os.remove(TMP)
