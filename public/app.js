const app=document.querySelector('#app');
let state,tab='overview',site='',search='';
let month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit'}).format(new Date());

const types={annual:'特休',personal:'事假',sick:'病假',comp:'補休',overtime:'加班'};
const roles={admin:'管理員',manager:'工地主任',employee:'員工'};
const colors={annual:'#73a889',personal:'#d8b46f',sick:'#ba8f93',comp:'#819eba',overtime:'#476d62'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(url,body){
  const r=await fetch('/api/'+url,{
    method:body?'POST':'GET',
    headers:body?{'Content-Type':'application/json'}:{},
    body:body?JSON.stringify(body):undefined
  });
  const d=await r.json();
  if(!r.ok){
    if(r.status===401)login();
    throw Error(d.error);
  }
  return d;
}

function toast(s){
  const el=document.createElement('div');
  el.className='toast';
  el.textContent=s;
  document.body.append(el);
  setTimeout(()=>el.remove(),3500);
}

function login(){
  app.innerHTML=`<form class="login">
    <div class="brand">工務日常<small>CONSTRUCTION WORKSPACE</small></div>
    <h2>登入休假管理</h2>
    <p>讓每個工地的出勤，一目了然。</p>
    <label>帳號<input name="username" autocomplete="username" required></label>
    <label>密碼<input name="password" type="password" autocomplete="current-password" required></label>
    <div class="error"></div>
    <button class="primary">登入系統 →</button>
  </form>`;
  app.querySelector('form').onsubmit=async e=>{
    e.preventDefault();
    try{
      await api('login',Object.fromEntries(new FormData(e.target)));
      await load();
    }catch(err){
      e.target.querySelector('.error').textContent=err.message;
    }
  };
}

async function load(){
  try{
    state=await api('state?month='+month);
    render();
  }catch(e){
    if(!app.querySelector('.login'))toast(e.message);
  }
}

function employees(){
  return state.employees.filter(e=>
    (!site||e.site===site)&&
    (!search||[e.name,e.title,e.site].some(v=>v.includes(search)))
  );
}

function records(){
  return state.records.filter(r=>
    r.date.startsWith(month)&&employees().some(e=>e.id===r.employee_id)
  );
}

function render(){
  const admin=state.user.role==='admin';
  const es=employees(),rs=records();
  const approved=rs.filter(r=>r.status==='approved');
  const sum=type=>approved
    .filter(r=>type?r.type===type:r.type!=='overtime')
    .reduce((s,r)=>s+r.hours,0);
  const titles={
    overview:['出勤總覽','掌握每個工地的休假與加班，讓安排更從容。'],
    people:['人員管理','統一管理人員、到職日期與特休額度。'],
    records:['休假與加班','登錄、審核與查閱每一筆出勤異動。'],
    accounts:['權限管理','依角色與所屬工地，控管資料存取。']
  };
  const tabs=[
    ['overview','◫ 出勤總覽'],
    ['people','♙ 人員管理'],
    ['records','▤ 休假與加班'],
    ...(admin?[['accounts','⚙ 權限管理']]:[])
  ];

  let content='';
  if(tab==='overview'){
    content=`
      <div class="cards">
        <div class="card"><small>在冊人員</small><strong>${es.length}<small> 人</small></strong><span>目前可見的人員</span></div>
        <div class="card"><small>當月休假</small><strong>${sum()}<small> 小時</small></strong><span>已核准 · 含特休與補休</span></div>
        <div class="card"><small>當月加班</small><strong>${sum('overtime')}<small> 小時</small></strong><span>暫按 1 : 1 累積補休</span></div>
        <div class="card"><small>待審核申請</small><strong>${rs.filter(r=>r.status==='pending').length}<small> 筆</small></strong><span>結算前請完成審核</span></div>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>當月出勤異動圖表</h2>${filters()}</div>
        <div class="legend">
          ${Object.entries(types).map(([k,v])=>`<span><i class="dot" style="background:${colors[k]}"></i>${v}</span>`).join('')}
        </div>
        ${chart(es,approved)}
        <p class="muted">圖表為已核准的休假與加班時數；尚未串接打卡，無法判定實際出勤或缺勤。</p>
      </section>
      ${peopleTable(es)}
      <div class="notice">特休參考台灣勞基法第 38 條年資級距，以所選月份月底計算，1 日暫按 8 小時。年度使用量暫按曆年統計；周年制、比例折算、結轉與離職結清須待公司制度確認。</div>`;
  }else if(tab==='people'){
    content=`
      ${admin?`<div class="actions">
        <button class="primary" id="addPerson">＋ 新增人員</button>
        <button id="import">匯入 CSV</button>
        <button id="template">下載匯入範本</button>
      </div>
      <p class="muted">欄位：姓名、職稱、所屬工地、到職日期、特休調整時數。匯入為新增，請避免重複匯入。</p>`:''}
      ${peopleTable(es)}`;
  }else if(tab==='records'){
    content=recordTable(rs);
  }else{
    content=accounts();
  }

  app.innerHTML=`
    <aside>
      <div class="brand">工務日常<small>CONSTRUCTION WORKSPACE</small></div>
      <nav>${tabs.map(([id,t])=>`<button data-tab="${id}" class="${tab===id?'active':''}">${t}</button>`).join('')}</nav>
      <footer>營造團隊的日常助手<br>以人為本，井然有序。</footer>
    </aside>
    <main>
      <div class="top">
        <span>工作空間 / 休假管理</span>
        <span>${esc(state.user.username)} · ${roles[state.user.role]}
          <button id="password">改密碼</button>
          <button id="logout">登出</button>
        </span>
      </div>
      <div class="heading">
        <div><h1>${titles[tab][0]}</h1><p>${titles[tab][1]}</p></div>
        <div class="actions">
          <input id="month" type="month" value="${month}">
          <span class="pill">${state.closed?'已結算':'開放登錄'}</span>
          ${admin?`<button id="close">${state.closed?'重新開啟':'月份結算'}</button>`:''}
          <button class="primary" id="addRecord">＋ 新增紀錄</button>
        </div>
      </div>
      ${content}
      <p class="muted">${month} 月資料 · 休假以 2 小時為單位 · 資料儲存於伺服器</p>
    </main>`;
  bind();
}

function filters(){
  return `<div class="filters">
    <input class="search" placeholder="搜尋姓名、職稱…" value="${esc(search)}">
    <select class="site-filter">
      <option value="">全部工地</option>
      ${[...new Set(state.employees.map(e=>e.site))].map(s=>`<option ${s===site?'selected':''}>${esc(s)}</option>`).join('')}
    </select>
  </div>`;
}

function peopleTable(es){
  return `<section class="panel">
    <div class="panel-head"><h2>人員休假餘額</h2>${filters()}</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>姓名 / 職稱</th><th>所屬工地</th><th>到職日期</th>
          <th>法定級距</th><th>調整時數</th><th>本年已用</th>
          <th>參考剩餘</th><th>補休餘額</th>
          ${state.user.role==='admin'?'<th></th>':''}
        </tr></thead>
        <tbody>${es.map(e=>`<tr>
          <td><b>${esc(e.name)}</b><small>${esc(e.title)}</small></td>
          <td><span class="pill">${esc(e.site)}</span></td>
          <td>${e.hire}</td><td>${e.annualDays} 日</td>
          <td>${e.adjustment>0?'+':''}${e.adjustment} h</td>
          <td>${e.annualUsed} h</td>
          <td><b>${e.annualHours-e.annualUsed} h</b></td>
          <td>${e.compBalance} h</td>
          ${state.user.role==='admin'?`<td><button data-edit="${e.id}">編輯</button></td>`:''}
        </tr>`).join('')}</tbody>
      </table>
      ${es.length?'':'<div class="empty">尚無人員資料，請新增人員或匯入 CSV。</div>'}
    </div>
  </section>`;
}

function chart(es,rs){
  const totals=es.map(e=>rs.filter(r=>r.employee_id===e.id).reduce((s,r)=>s+r.hours,0));
  const max=Math.max(8,...totals);
  return es.length?es.map((e,i)=>`
    <div class="chart-row">
      <span>${esc(e.name)}</span>
      <div class="track">
        ${Object.keys(types).map(t=>{
          const h=rs.filter(r=>r.employee_id===e.id&&r.type===t).reduce((s,r)=>s+r.hours,0);
          return `<span class="segment" style="width:${h/max*100}%;background:${colors[t]}" title="${types[t]} ${h} 小時"></span>`;
        }).join('')}
      </div>
      <span class="muted">${totals[i]} 小時</span>
    </div>`).join(''):'<div class="empty">匯入人員後，即可查看每位同仁的每月圖表。</div>';
}

function recordTable(rs){
  return `<section class="panel">
    <div class="panel-head">
      <h2>當月紀錄</h2>
      <div class="actions">${filters()}<button id="export">匯出 CSV</button></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>日期</th><th>人員</th><th>類別</th><th>時數</th><th>備註</th><th>狀態</th><th>操作</th></tr></thead>
        <tbody>${rs.map(r=>`<tr>
          <td>${r.date}</td>
          <td>${esc(state.employees.find(e=>e.id===r.employee_id)?.name)}</td>
          <td>${types[r.type]}</td><td>${r.hours} h</td>
          <td>${esc(r.note)}</td>
          <td><span class="pill ${r.status}">${{approved:'已核准',pending:'待審核',rejected:'已駁回'}[r.status]}</span></td>
          <td>${state.user.role!=='employee'&&!state.closed?`
            <button data-review="${r.id}" data-status="approved">核准</button>
            <button data-review="${r.id}" data-status="rejected">駁回 / 作廢</button>`:'—'}
          </td>
        </tr>`).join('')}</tbody>
      </table>
      ${rs.length?'':'<div class="empty">本月尚無休假或加班紀錄。</div>'}
    </div>
  </section>`;
}

function accounts(){
  return `<section class="panel">
    <div class="panel-head"><h2>使用者帳號</h2><button class="primary" id="addUser">＋ 建立帳號</button></div>
    <table>
      <thead><tr><th>帳號</th><th>角色</th><th>存取範圍</th></tr></thead>
      <tbody>${state.users.map(u=>`<tr>
        <td>${esc(u.username)}</td><td>${roles[u.role]}</td>
        <td>${esc(u.role==='admin'?'所有工地與人員':u.role==='manager'?u.site:state.employees.find(e=>e.id===u.employee_id)?.name)}</td>
      </tr>`).join('')}</tbody>
    </table>
    <p>管理員：人員、帳號、月結及全公司紀錄。工地主任：所屬工地紀錄與審核。員工：僅查看自己、提交待審申請。</p>
  </section>`;
}

function dialog(title,fields,save){
  const d=document.createElement('dialog');
  d.innerHTML=`<form>
    <h2>${title}</h2>${fields}<div class="error"></div>
    <div class="actions"><button type="button" id="cancel">取消</button><button class="primary">儲存</button></div>
  </form>`;
  document.body.append(d);
  d.showModal();
  d.querySelector('#cancel').onclick=()=>d.close();
  d.onclose=()=>d.remove();
  d.querySelector('form').onsubmit=async e=>{
    e.preventDefault();
    try{
      await save(Object.fromEntries(new FormData(e.target)));
      d.close();
      toast('已儲存');
      await load();
    }catch(err){
      d.querySelector('.error').textContent=err.message;
    }
  };
  return d;
}

const field=(label,name,type='text',value='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" required></label>`;
const options=()=>state.employees.map(e=>`<option value="${e.id}">${esc(e.name)} · ${esc(e.site)}</option>`).join('');

function person(id){
  const e=state.employees.find(e=>e.id===id)||{};
  dialog(id?'編輯人員':'新增人員',
    field('姓名','name','text',e.name)+
    field('職稱','title','text',e.title)+
    field('所屬工地','site','text',e.site)+
    field('到職日期','hire','date',e.hire)+
    field('特休手動調整（小時，可為負數）','adjustment','number',e.adjustment||0),
    b=>api('employees',{...b,id,adjustment:Number(b.adjustment)})
  );
}

function download(name,text){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/csv;charset=utf-8'}));
  a.download=name;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

function csv(text){
  const rows=[];
  let row=[],s='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){
      if(quoted&&text[i+1]==='"'){s+='"';i++;}
      else quoted=!quoted;
    }else if(c===','&&!quoted){
      row.push(s);s='';
    }else if((c==='\n'||c==='\r')&&!quoted){
      if(c==='\r'&&text[i+1]==='\n')i++;
      row.push(s);
      if(row.some(x=>x.trim()))rows.push(row);
      row=[];s='';
    }else s+=c;
  }
  if(quoted)throw Error('CSV 引號未閉合');
  row.push(s);
  if(row.some(x=>x.trim()))rows.push(row);
  return rows;
}

function bind(){
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{
    tab=b.dataset.tab;
    render();
  });
  document.querySelector('#month').onchange=e=>{
    if(e.target.value){month=e.target.value;load();}
  };
  document.querySelectorAll('.site-filter').forEach(el=>el.onchange=e=>{
    site=e.target.value;render();
  });
  document.querySelectorAll('.search').forEach(el=>el.onchange=e=>{
    search=e.target.value;render();
  });
  document.querySelector('#logout').onclick=async()=>{
    await api('logout',{});
    login();
  };
  document.querySelector('#password').onclick=()=>dialog('修改密碼',
    field('目前密碼','current','password')+
    field('新密碼（至少 12 字元）','password','password'),
    b=>api('password',b)
  );
  document.querySelector('#addRecord').onclick=()=>{
    if(state.closed)return toast('此月份已結算');
    if(!state.employees.length)return toast('請先新增人員');
    dialog('新增休假 / 加班',
      `<label>人員<select name="employee_id">${options()}</select></label>`+
      field('日期','date','date',month+'-01')+
      `<label>類別<select name="type">${Object.entries(types).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>
      <label>時數（休假為 2 小時倍數）<input name="hours" type="number" min="0.5" max="24" step="0.5" value="2" required></label>
      <label>備註<input name="note" maxlength="500"></label>
      <p class="muted">員工申請須經審核。餘額可呈負數，供主管處理；目前不強制攔截超額申請。</p>`,
      b=>api('records',{...b,employee_id:Number(b.employee_id),hours:Number(b.hours)})
    );
  };

  const close=document.querySelector('#close');
  if(close)close.onclick=async()=>{
    if(!confirm(state.closed?'重新開啟後可以修改此月紀錄，確定？':'結算後鎖定此月份所有紀錄，確定？'))return;
    try{
      await api('month',{month,closed:!state.closed});
      await load();
    }catch(e){toast(e.message);}
  };

  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>person(Number(b.dataset.edit)));
  document.querySelector('#addPerson')?.addEventListener('click',()=>person());
  document.querySelectorAll('[data-review]').forEach(b=>b.onclick=async()=>{
    try{
      await api('review',{id:Number(b.dataset.review),status:b.dataset.status});
      await load();
    }catch(e){toast(e.message);}
  });

  document.querySelector('#template')?.addEventListener('click',()=>download(
    '人員匯入範本.csv',
    '姓名,職稱,所屬工地,到職日期,特休調整時數\n王小明,工程師,台北工地,2024-01-15,0\n'
  ));

  document.querySelector('#import')?.addEventListener('click',()=>{
    const d=dialog('匯入人員 CSV',
      '<p>UTF-8 CSV，日期為 YYYY-MM-DD。匯入為新增人員；整批檢查通過才儲存。</p><label>CSV 檔案<input id="csvFile" type="file" accept=".csv" required></label>',
      async()=>{
        const f=d.querySelector('#csvFile').files[0];
        const rows=csv((await f.text()).replace(/^\uFEFF/,''));
        if(rows[0]?.join(',')!=='姓名,職稱,所屬工地,到職日期,特休調整時數'){
          throw Error('標題欄位須與範本相同');
        }
        await api('employees',{
          rows:rows.slice(1).map(r=>({
            name:r[0],title:r[1],site:r[2],hire:r[3],
            adjustment:Number(r[4]||0)
          }))
        });
      }
    );
  });

  document.querySelector('#export')?.addEventListener('click',()=>{
    const q=v=>'"'+String(v).replace(/^[=+@-]/,'\t$&').replace(/"/g,'""')+'"';
    download(month+'休假紀錄.csv',[
      '日期,姓名,類別,時數,狀態,備註',
      ...records().map(r=>[
        r.date,
        state.employees.find(e=>e.id===r.employee_id)?.name,
        types[r.type],r.hours,r.status,r.note
      ].map(q).join(','))
    ].join('\n'));
  });

  document.querySelector('#addUser')?.addEventListener('click',()=>dialog('建立帳號',
    field('帳號（英數字）','username')+
    field('初始密碼（至少 12 字元）','password','password')+
    `<label>角色<select name="role">
      <option value="employee">員工</option>
      <option value="manager">工地主任</option>
      <option value="admin">管理員</option>
    </select></label>
    <label>綁定人員（員工必填）<select name="employee_id">
      <option value="">請選擇</option>${options()}
    </select></label>
    <label>所屬工地（主任必填）<select name="site">
      <option value="">請選擇</option>
      ${[...new Set(state.employees.map(e=>e.site))].map(s=>`<option>${esc(s)}</option>`).join('')}
    </select></label>`,
    b=>api('users',b)
  ));
}

load();
