const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('登入、權限、審核、月結與資料保存', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-test-'));
  const port = 32000 + Math.floor(Math.random() * 10000);
  const password = 'test-password-123456';
  let child;

  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        ADMIN_PASSWORD: password,
        APP_ORIGIN: 'https://leave.example.com',
        COOKIE_SECURE: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('啟動逾時')),
        15000
      );

      child.stdout.on('data', buffer => {
        if (buffer.toString().includes('啟動')) {
          clearTimeout(timer);
          resolve();
        }
      });

      child.once('exit', () => {
        clearTimeout(timer);
        reject(Error('伺服器提前停止'));
      });
    });
  }

  async function stop() {
    await new Promise(resolve => {
      child.once('exit', resolve);
      child.kill();
    });
  }

  t.after(async () => {
    if (child && child.exitCode === null) await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await start();

  async function request(endpoint, data, cookie = '', origin = '') {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/${endpoint}`,
      {
        method: data ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          ...(origin ? { Origin: origin } : {})
        },
        body: data ? JSON.stringify(data) : undefined
      }
    );

    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0]
    };
  }

  assert.equal(
    (await request('state?month=2026-10')).status,
    401
  );

  const admin = (await request('login', {
    username: 'admin',
    password
  })).cookie;

  assert.ok(admin);

  assert.equal(
    (await request('login', {
      username: 'admin',
      password
    }, '', 'https://evil.example')).status,
    403
  );

  assert.equal(
    (await request('login', {
      username: 'admin',
      password
    }, '', 'https://leave.example.com')).status,
    200
  );

  assert.equal(
    (await request('employees', {
      rows: [
        {
          name: '甲',
          title: '工程師',
          site: '台北',
          hire: '2024-01-01'
        },
        {
          name: '乙',
          title: '主任',
          site: '台中',
          hire: '2020-02-29'
        }
      ]
    }, admin)).status,
    200
  );

  let state = (await request(
    'state?month=2026-10', null, admin
  )).body;

  const a = state.employees.find(e => e.name === '甲').id;
  const b = state.employees.find(e => e.name === '乙').id;

  for (const user of [
    { username: 'staff', role: 'employee', employee_id: a },
    { username: 'manager', role: 'manager', site: '台北' }
  ]) {
    assert.equal(
      (await request('users', { ...user, password }, admin)).status,
      200
    );
  }

  const staff = (await request('login', {
    username: 'staff',
    password
  })).cookie;

  const manager = (await request('login', {
    username: 'manager',
    password
  })).cookie;

  assert.equal(
    (await request('state?month=2026-10', null, staff))
      .body.employees.length,
    1
  );

  assert.equal(
    (await request('state?month=2026-10', null, manager))
      .body.employees.length,
    1
  );

  const record = {
    employee_id: a,
    date: '2026-10-07',
    type: 'annual',
    hours: 2,
    note: '測試'
  };

  assert.equal(
    (await request('records', {
      ...record, employee_id: b
    }, staff)).status,
    403
  );

  assert.equal(
    (await request('records', {
      ...record, hours: 3
    }, staff)).status,
    400
  );

  assert.equal(
    (await request('records', record, staff)).status,
    200
  );

  assert.equal(
    (await request('month', {
      month: '2026-10', closed: true
    }, admin)).status,
    400
  );

  state = (await request(
    'state?month=2026-10', null, admin
  )).body;

  assert.equal(state.records[0].status, 'pending');

  const review = {
    id: state.records[0].id,
    status: 'approved'
  };

  assert.equal(
    (await request('review', review, staff)).status,
    403
  );

  assert.equal(
    (await request('review', review, manager)).status,
    200
  );

  assert.equal(
    (await request('records', {
      ...record, type: 'overtime', hours: 4
    }, admin)).status,
    200
  );

  assert.equal(
    (await request('records', {
      ...record, type: 'comp', hours: 2
    }, admin)).status,
    200
  );

  state = (await request(
    'state?month=2026-10', null, admin
  )).body;

  const person = state.employees.find(e => e.id === a);
  assert.equal(person.annualUsed, 2);
  assert.equal(person.compBalance, 2);

  assert.equal(
    (await request('month', {
      month: '2026-10', closed: true
    }, manager)).status,
    403
  );

  assert.equal(
    (await request('month', {
      month: '2026-10', closed: true
    }, admin)).status,
    200
  );

  assert.equal(
    (await request('records', record, admin)).status,
    400
  );

  assert.equal(
    (await request('review', {
      id: state.records[0].id,
      status: 'rejected'
    }, admin)).status,
    400
  );

  assert.equal(
    (await request('employees', {
      rows: [
        {
          name: '有效',
          title: '工程師',
          site: '台北',
          hire: '2024-01-01'
        },
        {
          name: '錯誤',
          title: '工程師',
          site: '台北',
          hire: '2024-02-30'
        }
      ]
    }, admin)).status,
    400
  );

  assert.equal(
    (await request('state?month=2026-10', null, admin))
      .body.employees.length,
    2
  );

  await stop();
  await start();

  state = (await request(
    'state?month=2026-10', null, admin
  )).body;

  assert.equal(state.closed, true);
  assert.equal(state.records.length, 3);
  assert.equal(state.employees.length, 2);
});
