const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { entitlement } = require('./rules');

process.umask(0o077);

const publicOrigin =
  process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL;

if (publicOrigin) {
  const parsed = new URL(publicOrigin);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== publicOrigin
  ) {
    throw Error('APP_ORIGIN 必須是完整 origin，不含路徑或尾端斜線');
  }
}

const data = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(data, { recursive: true });

const db = new DatabaseSync(path.join(data, 'leave.sqlite'));
db.exec(`
  PRAGMA foreign_keys=ON;
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS employees(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    site TEXT NOT NULL,
    hire TEXT NOT NULL,
    adjustment REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL,
    employee_id INTEGER REFERENCES employees(id),
    site TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    expires INTEGER
  );

  CREATE TABLE IF NOT EXISTS records(
    id INTEGER PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    hours REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS months(
    month TEXT PRIMARY KEY,
    closed INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS audit(
    id INTEGER PRIMARY KEY,
    time TEXT DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER,
    action TEXT,
    detail TEXT
  );
`);

const hash = (password, salt) =>
  crypto.scryptSync(password, salt, 64).toString('hex');

function addUser(username, password, role, employeeId = null, site = '') {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO users(username,hash,salt,role,employee_id,site)
    VALUES(?,?,?,?,?,?)
  `).run(username, hash(password, salt), salt, role, employeeId, site);
}

if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
  const password =
    process.env.ADMIN_PASSWORD ||
    crypto.randomBytes(18).toString('base64url');

  addUser('admin', password, 'admin');

  if (!process.env.ADMIN_PASSWORD) {
    fs.writeFileSync(
      path.join(data, 'initial-admin-password'),
      password,
      { mode: 0o600 }
    );
    console.log('初始管理員密碼已存於資料目錄，請登入後修改。');
  }
}

function audit(user, action, detail) {
  db.prepare(`
    INSERT INTO audit(user_id,action,detail) VALUES(?,?,?)
  `).run(user.id, action, JSON.stringify(detail));
}

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

function access(user, person) {
  return (
    user.role === 'admin' ||
    (user.role === 'manager' && user.site === person.site) ||
    (user.role === 'employee' && user.employee_id === person.id)
  );
}

function employee(user, id) {
  const person = db.prepare(
    'SELECT * FROM employees WHERE id=?'
  ).get(Number(id));

  if (!person || !access(user, person)) {
    fail('無權存取此人員', 403);
  }
  return person;
}

function unlocked(date) {
  const closed = db.prepare(`
    SELECT month FROM months WHERE month=? AND closed=1
  `).get(date.slice(0, 7));

  if (closed) fail('此月份已結算，請管理員先重新開啟');
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1000000) fail('資料過大', 413);
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    fail('資料格式錯誤');
  }
}

const attempts = new Map();

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
    );

    if (!p.startsWith('/api/')) {
      const file = {
        '/': 'index.html',
        '/app.js': 'app.js',
        '/style.css': 'style.css'
      }[p];

      if (!file) return json(res, 404, { error: '找不到頁面' });

      res.setHeader(
        'Content-Type',
        file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html; charset=utf-8'
      );

      return fs.createReadStream(
        path.join(__dirname, 'public', file)
      ).pipe(res);
    }

    const expectedOrigin = publicOrigin ||
      `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;

    if (
      req.method !== 'GET' &&
      req.headers.origin &&
      req.headers.origin !== expectedOrigin
    ) {
      fail('來源不符', 403);
    }

    const b = req.method === 'GET' ? {} : await body(req);

    if (p === '/api/login' && req.method === 'POST') {
      const key = req.socket.remoteAddress;
      const now = Date.now();
      let attempt = attempts.get(key);

      if (
        attempt &&
        now - attempt.time < 60000 &&
        attempt.count >= 10
      ) {
        fail('登入嘗試過多，請稍後再試', 429);
      }

      if (!attempt || now - attempt.time >= 60000) {
        attempt = { time: now, count: 0 };
      }

      attempt.count++;
      attempts.set(key, attempt);

      const user = db.prepare(
        'SELECT * FROM users WHERE username=?'
      ).get(String(b.username || ''));

      if (
        !user ||
        typeof b.password !== 'string' ||
        !crypto.timingSafeEqual(
          Buffer.from(hash(b.password, user.salt), 'hex'),
          Buffer.from(user.hash, 'hex')
        )
      ) {
        fail('帳號或密碼錯誤', 401);
      }

      attempts.delete(key);
      const token = crypto.randomBytes(32).toString('hex');

      db.prepare('INSERT INTO sessions VALUES(?,?,?)')
        .run(token, user.id, now + 8 * 3600000);

      res.setHeader(
        'Set-Cookie',
        `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`
      );

      return json(res, 200, { ok: true });
    }

    const token = (req.headers.cookie || '')
      .match(/(?:^|;\s*)session=([a-f0-9]+)/)?.[1];

    const user = token && db.prepare(`
      SELECT u.* FROM users u
      JOIN sessions s ON s.user_id=u.id
      WHERE s.token=? AND s.expires>?
    `).get(token, Date.now());

    if (!user) fail('請先登入', 401);

    if (p === '/api/logout') {
      db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      res.setHeader(
        'Set-Cookie',
        'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
      );
      return json(res, 200, { ok: true });
    }

    if (p === '/api/password' && req.method === 'POST') {
      if (
        typeof b.current !== 'string' ||
        hash(b.current, user.salt) !== user.hash
      ) {
        fail('目前密碼錯誤');
      }

      if (
        typeof b.password !== 'string' ||
        b.password.length < 12 ||
        b.password.length > 200
      ) {
        fail('新密碼須為 12–200 字元');
      }

      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE users SET hash=?,salt=? WHERE id=?')
        .run(hash(b.password, salt), salt, user.id);

      db.prepare(
        'DELETE FROM sessions WHERE user_id=? AND token<>?'
      ).run(user.id, token);

      return json(res, 200, { ok: true });
    }

    if (p === '/api/state' && req.method === 'GET') {
      const month = url.searchParams.get('month');

      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) {
        fail('月份錯誤');
      }

      const people = db.prepare(
        'SELECT * FROM employees ORDER BY site,name'
      ).all().filter(person => access(user, person));

      const ids = new Set(people.map(person => person.id));

      const records = db.prepare(
        'SELECT * FROM records ORDER BY date DESC,id DESC'
      ).all().filter(record => ids.has(record.employee_id));

      const asOf = month + '-' + new Date(
        Number(month.slice(0, 4)),
        Number(month.slice(5)),
        0
      ).getDate();

      const year = month.slice(0, 4);

      return json(res, 200, {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          site: user.site
        },
        employees: people.map(person => ({
          ...person,
          annualDays: entitlement(person.hire, asOf),
          annualHours:
            entitlement(person.hire, asOf) * 8 + person.adjustment,
          annualUsed: records.filter(record =>
            record.employee_id === person.id &&
            record.type === 'annual' &&
            record.status === 'approved' &&
            record.date.startsWith(year)
          ).reduce((sum, record) => sum + record.hours, 0),
          compBalance: records.filter(record =>
            record.employee_id === person.id &&
            record.status === 'approved'
          ).reduce((sum, record) =>
            sum + (
              record.type === 'overtime' ? record.hours :
              record.type === 'comp' ? -record.hours : 0
            ), 0)
        })),
        records,
        closed: !!db.prepare(`
          SELECT month FROM months WHERE month=? AND closed=1
        `).get(month),
        users: user.role === 'admin'
          ? db.prepare(`
              SELECT id,username,role,employee_id,site FROM users
            `).all()
          : []
      });
    }

    if (p === '/api/employees' && req.method === 'POST') {
      if (user.role !== 'admin') {
        fail('僅管理員可編輯人員', 403);
      }

      const rows = b.rows || [b];

      if (!Array.isArray(rows) || !rows.length || rows.length > 500) {
        fail('匯入須為 1–500 筆');
      }

      for (const person of rows) {
        if (
          ![person.name, person.title, person.site].every(value =>
            typeof value === 'string' &&
            value.trim() &&
            value.length <= 100
          ) ||
          !validDate(person.hire) ||
          !Number.isFinite(Number(person.adjustment || 0))
        ) {
          fail('姓名、職稱、工地或到職日期格式錯誤');
        }

        if (
          person.id &&
          !db.prepare('SELECT id FROM employees WHERE id=?')
            .get(person.id)
        ) {
          fail('人員不存在');
        }
      }

      db.exec('BEGIN');

      try {
        for (const person of rows) {
          if (person.id) {
            db.prepare(`
              UPDATE employees
              SET name=?,title=?,site=?,hire=?,adjustment=?
              WHERE id=?
            `).run(
              person.name.trim(),
              person.title.trim(),
              person.site.trim(),
              person.hire,
              Number(person.adjustment || 0),
              person.id
            );
          } else {
            db.prepare(`
              INSERT INTO employees(name,title,site,hire,adjustment)
              VALUES(?,?,?,?,?)
            `).run(
              person.name.trim(),
              person.title.trim(),
              person.site.trim(),
              person.hire,
              Number(person.adjustment || 0)
            );
          }
        }

        audit(user, 'employees', { count: rows.length });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      return json(res, 200, { ok: true });
    }

    if (p === '/api/records' && req.method === 'POST') {
      employee(user, b.employee_id);

      if (
        !validDate(b.date) ||
        !['annual', 'personal', 'sick', 'comp', 'overtime']
          .includes(b.type) ||
        !Number.isFinite(b.hours) ||
        b.hours <= 0 ||
        b.hours > 24 ||
        (b.type !== 'overtime' && b.hours % 2 !== 0)
      ) {
        fail('休假須以 2 小時為單位，每筆最多 24 小時');
      }

      unlocked(b.date);

      if (typeof b.note !== 'string' || b.note.length > 500) {
        fail('備註過長');
      }

      const status =
        user.role === 'employee' ? 'pending' : 'approved';

      db.prepare(`
        INSERT INTO records(
          employee_id,date,type,hours,note,status,created_by
        ) VALUES(?,?,?,?,?,?,?)
      `).run(
        b.employee_id, b.date, b.type,
        b.hours, b.note, status, user.id
      );

      audit(user, 'record.create', b);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/review' && req.method === 'POST') {
      if (user.role === 'employee') fail('無審核權限', 403);

      const record = db.prepare(
        'SELECT * FROM records WHERE id=?'
      ).get(b.id);

      if (!record) fail('紀錄不存在');
      employee(user, record.employee_id);
      unlocked(record.date);

      if (!['approved', 'rejected'].includes(b.status)) {
        fail('狀態錯誤');
      }

      db.prepare('UPDATE records SET status=? WHERE id=?')
        .run(b.status, record.id);

      audit(user, 'record.review', b);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/month' && req.method === 'POST') {
      if (user.role !== 'admin') fail('僅管理員可結算', 403);

      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month || '')) {
        fail('月份錯誤');
      }

      if (
        b.closed &&
        db.prepare(`
          SELECT id FROM records
          WHERE substr(date,1,7)=? AND status='pending'
        `).get(b.month)
      ) {
        fail('請先處理當月待審申請');
      }

      db.prepare(`
        INSERT INTO months(month,closed) VALUES(?,?)
        ON CONFLICT(month) DO UPDATE SET closed=excluded.closed
      `).run(b.month, b.closed ? 1 : 0);

      audit(user, 'month.close', b);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/users' && req.method === 'POST') {
      if (user.role !== 'admin') {
        fail('僅管理員可建立帳號', 403);
      }

      if (
        !/^[a-zA-Z0-9_.-]{3,50}$/.test(b.username || '') ||
        typeof b.password !== 'string' ||
        b.password.length < 12 ||
        b.password.length > 200 ||
        !['admin', 'manager', 'employee'].includes(b.role)
      ) {
        fail('帳號格式錯誤或密碼少於 12 字元');
      }

      if (b.role === 'employee') employee(user, b.employee_id);

      if (
        b.role === 'manager' &&
        (!b.site || !db.prepare(
          'SELECT id FROM employees WHERE site=?'
        ).get(b.site))
      ) {
        fail('請指定現有工地');
      }

      try {
        addUser(
          b.username,
          b.password,
          b.role,
          b.role === 'employee' ? Number(b.employee_id) : null,
          b.role === 'manager' ? b.site : ''
        );
      } catch (error) {
        if (error.message.includes('UNIQUE')) fail('帳號已存在');
        throw error;
      }

      audit(user, 'user.create', {
        username: b.username,
        role: b.role
      });

      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: '找不到操作' });
  } catch (error) {
    if (!error.status) console.error(error.message);
    json(res, error.status || 500, {
      error: error.status
        ? error.message
        : '系統錯誤，請聯絡管理員'
    });
  }
}).listen(
  Number(process.env.PORT || 3000),
  '0.0.0.0',
  () => console.log(
    '休假管理系統啟動，port ' + (process.env.PORT || 3000)
  )
);
