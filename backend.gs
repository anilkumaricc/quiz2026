/**
 * FILE: backend.gs
 * Full Google Apps Script backend for ADCA Quiz System.
 *
 * ScriptProperties must match EXACT values in Master Prompt.
 *
 * Deploy: Save and Deploy → Web app (Execute as: Me, Who has access: Anyone)
 *
 * This script:
 *  - auto-creates sheets (Submissions, Questions, HWCW, AuditLogs)
 *  - serves Index HTML when action=index or no action
 *  - provides API endpoints: ping, gettoken, questions, hwcw, listbyroll, listall, export, delete
 *  - implements token HMAC signing (SECRET_ENC_KEY)
 *  - prevents duplicate submissions within DUP_WINDOW_MIN minutes
 *  - saves submission JSON; strips raw mobile and stores hashed mobile
 *  - returns JSON responses for all API calls
 */

const SCRIPT_PROPS = {
  SHEET_ID: "1qdyyByyXkiDEmr8gwNmrlbhS-e3RqhHB0HzRwr-DpDA",
  SHEET_NAME: "Submissions",
  PRIMARY_KEY: "primary_Ea7f4c2b",
  ADMIN_KEY: "admin_Zk3q9p8X",
  SECRET_ENC_KEY: "R9pB7kXwM2hJ4tFzQ5vL1yC0oA6uI3eD8sY",
  PHONE_SECRET: "icC@2026",
  DUP_WINDOW_MIN: 3,
  TOKEN_TTL_MIN: 10
};

/* ---------- Utilities ---------- */
function sheetOpen(){
  return SpreadsheetApp.openById(SCRIPT_PROPS.SHEET_ID);
}

function ensureSheets(){
  const ss = sheetOpen();
  const names = ss.getSheets().map(s => s.getName());
  if(!names.includes(SCRIPT_PROPS.SHEET_NAME)){
    const s = ss.insertSheet(SCRIPT_PROPS.SHEET_NAME);
    // columns: _id, ts, pi, roll, mobile_hash, meta_json, questions_json
    s.appendRow(['_id','ts','pi','roll','mobile_hash','meta_json','questions_json']);
    s.getRange(1,1,1,7).setFontWeight('bold');
  }
  if(!names.includes('Questions')){
    const s = ss.insertSheet('Questions');
    s.appendRow(['id','q','opts_json','answerIndex','explanation']);
    s.getRange(1,1,1,5).setFontWeight('bold');
  }
  if(!names.includes('HWCW')){
    const s = ss.insertSheet('HWCW');
    s.appendRow(['title','summary','series','setNo']);
    s.getRange(1,1,1,4).setFontWeight('bold');
  }
  if(!names.includes('AuditLogs')){
    const s = ss.insertSheet('AuditLogs');
    s.appendRow(['ts','action','detail']);
    s.getRange(1,1,1,3).setFontWeight('bold');
  }
}

function logAudit(action, detail){
  try{
    const ss = sheetOpen();
    const s = ss.getSheetByName('AuditLogs');
    if(s) s.appendRow([new Date().toISOString(), action, JSON.stringify(detail || {})]);
  }catch(e){
    console.error('logAudit failed', e);
  }
}

/* ---------- HMAC / Token ---------- */
function _hmacSha256(message, key){
  // computeHmacSha256Signature returns byte[]; base64 encode for transport
  const raw = Utilities.computeHmacSha256Signature(message, key);
  return Utilities.base64Encode(raw);
}

// token payload: base64(JSON({pi,roll,iat,exp})) + '.' + hmac
function generateToken(pi, roll){
  const iat = Math.floor(Date.now()/1000);
  const exp = iat + (SCRIPT_PROPS.TOKEN_TTL_MIN * 60);
  const payload = {pi: pi || '', roll: roll || '', iat, exp};
  const b = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const mac = _hmacSha256(b, SCRIPT_PROPS.SECRET_ENC_KEY);
  return b + '.' + mac;
}

function verifyToken(token){
  try{
    if(!token) return {ok:false, error:'no token'};
    const parts = token.split('.');
    if(parts.length !== 2) return {ok:false, error:'invalid token format'};
    const b = parts[0]; const mac = parts[1];
    const expected = _hmacSha256(b, SCRIPT_PROPS.SECRET_ENC_KEY);
    if(expected !== mac) return {ok:false, error:'invalid signature'};
    const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(b)).getDataAsString());
    const now = Math.floor(Date.now()/1000);
    if(payload.exp < now) return {ok:false, error:'token expired'};
    return {ok:true, payload};
  }catch(e){
    return {ok:false, error:'verify error'};
  }
}

/* ---------- Helpers ---------- */
function contentJson(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function contentTextExport(csvText){
  return ContentService.createTextOutput(csvText).setMimeType(ContentService.MimeType.TEXT);
}

function _genId(){ return 'id_' + Utilities.getUuid().replace(/-/g,'').slice(0,20); }

/* ---------- Mobile privacy: hash helper ---------- */
function hashMobile(mobile){
  if(!mobile) return '';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, mobile, Utilities.Charset.UTF_8);
  return bytes.map(b=>('0'+(b & 0xFF).toString(16)).slice(-2)).join('');
}

/* ---------- Storage ---------- */
function saveSubmission(sub){
  try{
    const ss = sheetOpen();
    const s = ss.getSheetByName(SCRIPT_PROPS.SHEET_NAME);
    const id = _genId();
    const ts = Date.now();

    // extract mobile if present and hash it
    const mobile = (sub.meta && sub.meta.mobile) ? String(sub.meta.mobile).trim() : '';
    const mobile_hash = mobile ? hashMobile(mobile) : '';

    // remove raw mobile from meta before saving
    if(sub.meta && sub.meta.mobile) delete sub.meta.mobile;

    const metaJson = JSON.stringify(sub.meta || {});
    const questionsJson = JSON.stringify(sub.questions || []);
    s.appendRow([id, ts, (sub.meta && sub.meta.pi) || '', (sub.meta && sub.meta.roll) || '', mobile_hash, metaJson, questionsJson]);

    return {_id:id, ts, meta: sub.meta, questions: sub.questions};
  }catch(e){
    console.error('saveSubmission error', e);
    return null;
  }
}

function listAllSubmissions(){
  try{
    const ss = sheetOpen();
    const s = ss.getSheetByName(SCRIPT_PROPS.SHEET_NAME);
    const data = s.getDataRange().getValues().slice(1);
    const out = data.map(row=>{
      const id = row[0]; const ts = row[1]; const pi = row[2]; const roll = row[3];
      const mobile_hash = row[4] || '';
      const meta = row[5] ? JSON.parse(row[5]) : {};
      const questions = row[6] ? JSON.parse(row[6]) : [];
      return {_id: id, ts: ts, meta: meta, questions: questions, mobile_hash: mobile_hash};
    });
    out.sort((a,b)=> (b.ts||0) - (a.ts||0));
    return out;
  }catch(e){
    console.error('listAllSubmissions error', e);
    return [];
  }
}

function findSubmissionById(id){
  return listAllSubmissions().find(a => a._id === id) || null;
}

function deleteSubmissionById(id){
  try{
    const ss = sheetOpen();
    const s = ss.getSheetByName(SCRIPT_PROPS.SHEET_NAME);
    const vals = s.getDataRange().getValues();
    for(let i=1;i<vals.length;i++){
      if(vals[i][0] === id){
        s.deleteRow(i+1);
        logAudit('delete', {id});
        return true;
      }
    }
    return false;
  }catch(e){
    console.error('deleteSubmissionById error', e);
    return false;
  }
}

function listAllSubmissionsCSV(filterRoll, filterPI){
  const arr = listAllSubmissions().filter(r=>{
    if(filterRoll && filterRoll.trim()) return r.meta && r.meta.roll === filterRoll;
    if(filterPI && filterPI.trim()) return r.meta && r.meta.pi === filterPI;
    return true;
  });
  const header = ['_id','ts','pi','roll','studentName','series','setNo','score','total','mobile_hash','raw_questions'];
  const rows = [header.join(',')];
  arr.forEach(a=>{
    const total = (a.questions || []).length;
    let correct = 0;
    (a.questions||[]).forEach(q=> { if(typeof q.selected === 'number' && q.selected === q.answerIndex) correct++; });
    const row = [
      `"${a._id}"`,
      `"${new Date(a.ts).toISOString()}"`,
      `"${(a.meta && a.meta.pi) || ''}"`,
      `"${(a.meta && a.meta.roll) || ''}"`,
      `"${(a.meta && a.meta.studentName) || ''}"`,
      `"${(a.meta && a.meta.series) || ''}"`,
      `"${(a.meta && a.meta.setNo) || ''}"`,
      `"${correct}"`,
      `"${total}"`,
      `"${(a.mobile_hash||'')}"`,
      `"${JSON.stringify(a.questions).replace(/"/g,'""')}"`
    ];
    rows.push(row.join(','));
  });
  return rows.join('\n');
}

/* ---------- Duplicate prevention ---------- */
function checkDuplicate(meta){
  try{
    const roll = meta && meta.roll;
    const pi = meta && meta.pi;
    if(!roll && !pi) return {ok:true};
    const all = listAllSubmissions();
    const windowMs = SCRIPT_PROPS.DUP_WINDOW_MIN * 60 * 1000;
    const now = Date.now();
    const dup = all.find(a=>{
      if(pi && a.meta && a.meta.pi === pi) { if((now - (a.ts||0)) < windowMs) return true; }
      if(roll && a.meta && a.meta.roll === roll) { if((now - (a.ts||0)) < windowMs) return true; }
      return false;
    });
    if(dup) return {ok:false, error:'duplicate attempt within window'};
    return {ok:true};
  }catch(e){
    console.error('checkDuplicate error', e);
    return {ok:true};
  }
}

/* ---------- Questions / HWCW ---------- */
function loadQuestions(){
  try{
    const ss = sheetOpen();
    const s = ss.getSheetByName('Questions');
    if(!s) return [];
    const rows = s.getDataRange().getValues().slice(1);
    return rows.map(r=>{
      try{
        return {
          id: r[0] || Utilities.getUuid(),
          q: r[1] || '',
          opts: r[2] ? JSON.parse(r[2]) : [],
          answer: (typeof r[3] === 'number' ? r[3] : Number(r[3]||0)),
          explanation: r[4] || ''
        };
      }catch(e){
        return null;
      }
    }).filter(Boolean);
  }catch(e){
    console.error('loadQuestions error', e);
    return [];
  }
}

function loadHWCW(series, setNo){
  try{
    const ss = sheetOpen();
    const s = ss.getSheetByName('HWCW');
    if(!s) return [];
    const rows = s.getDataRange().getValues().slice(1);
    const out = rows.map(r=> ({title: r[0], summary: r[1], series: r[2], setNo: r[3]})).filter(it=>{
      if(series && it.series !== series) return false;
      if(setNo && String(it.setNo) !== String(setNo)) return false;
      return true;
    });
    return out;
  }catch(e){
    console.error('loadHWCW error', e);
    return [];
  }
}

/* ---------- doGet / doPost ---------- */
function doGet(e){
  try{ ensureSheets(); }catch(e){ /* continue */ }
  try{
    const params = e && e.parameter ? e.parameter : {};
    const raw = (params.action || 'ping').toString();
    const action = raw.trim().toLowerCase();

    if(!action || action === 'index' || action === 'quiz'){
      try{
        return HtmlService.createHtmlOutputFromFile('Index').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
      }catch(err){
        return contentJson({ok:false, error:'Index UI not found on server. Create an HTML file named \"Index\".'});
      }
    }

    if(action === 'ping') return contentJson({ok:true, msg:'ADCA Quiz Backend'});
    if(action === 'gettoken'){
      const pi = params.pi || ''; const roll = params.roll || '';
      const token = generateToken(pi, roll);
      logAudit('getToken', {pi, roll});
      return contentJson({ok:true, token});
    }
    if(action === 'questions') return contentJson({ok:true, questions: loadQuestions()});
    if(action === 'hwcw') return contentJson({ok:true, items: loadHWCW(params.series, params.setNo)});

    if(action === 'listbyroll' || action === 'listbypi'){
      if(params.admin && params.admin === SCRIPT_PROPS.ADMIN_KEY){
        let all = listAllSubmissions();
        if(params.roll) all = all.filter(r => r.meta && r.meta.roll === params.roll);
        if(params.pi) all = all.filter(r => r.meta && r.meta.pi === params.pi);
        return contentJson({ok:true, attempts: all});
      } else {
        const roll = params.roll || ''; const pi = params.pi || '';
        const all = listAllSubmissions();
        const filtered = all.filter(r=> (r.meta && ((r.meta.roll === roll) || (r.meta.pi === pi))));
        return contentJson({ok:true, attempts: filtered.map(r=> ({ts:r.ts, meta:r.meta}))});
      }
    }

    if(action === 'getattempt'){
      if(!params.admin || params.admin !== SCRIPT_PROPS.ADMIN_KEY) return contentJson({ok:false, error:'admin required'});
      if(!params.id) return contentJson({ok:false, error:'id required'});
      return contentJson({ok:true, attempt: findSubmissionById(params.id)});
    }

    if(action === 'listall'){
      if(!params.admin || params.admin !== SCRIPT_PROPS.ADMIN_KEY) return contentJson({ok:false, error:'admin required'});
      let list = listAllSubmissions();
      if(params.series) list = list.filter(r => r.meta && r.meta.series === params.series);
      if(params.roll) list = list.filter(r => r.meta && r.meta.roll === params.roll);
      if(params.pi) list = list.filter(r => r.meta && r.meta.pi === params.pi);
      return contentJson({ok:true, attempts:list});
    }

    if(action === 'export'){
      if(!params.admin || params.admin !== SCRIPT_PROPS.ADMIN_KEY) return contentJson({ok:false, error:'admin required'});
      return contentTextExport(listAllSubmissionsCSV(params.roll, params.pi));
    }

    if(action === 'delete'){
      if(!params.admin || params.admin !== SCRIPT_PROPS.ADMIN_KEY) return contentJson({ok:false, error:'admin required'});
      if(!params.id) return contentJson({ok:false, error:'id required'});
      const del = deleteSubmissionById(params.id);
      return contentJson(del ? {ok:true} : {ok:false, error:'not found'});
    }

    return contentJson({ok:false, error:'unknown action', action: raw});
  }catch(err){
    console.error('doGet error', err);
    return contentJson({ok:false, error: String(err)});
  }
}

function doPost(e){
  try{ ensureSheets(); }catch(e){ /* continue */ }
  try{
    const raw = e.postData && e.postData.contents;
    if(!raw) return contentJson({ok:false, error:'no payload'});
    const body = JSON.parse(raw);
    const action = (body.action || '').toString().trim().toLowerCase();

    if(action === 'submit'){
      const token = body.token;
      const tok = verifyToken(token);
      if(!tok.ok) return contentJson({ok:false, error:'invalid token'});
      if(body.primary !== SCRIPT_PROPS.PRIMARY_KEY) return contentJson({ok:false, error:'invalid primary key'});
      const submission = body.submission;
      if(!submission) return contentJson({ok:false, error:'submission missing'});
      const dupOk = checkDuplicate(submission.meta || {});
      if(!dupOk.ok) return contentJson({ok:false, error:dupOk.error});
      const saved = saveSubmission(submission);
      if(saved){ logAudit('submit', {pi: submission.meta && submission.meta.pi, roll: submission.meta && submission.meta.roll}); return contentJson({ok:true, id: saved._id}); }
      return contentJson({ok:false, error:'save failed'});
    }

    return contentJson({ok:false, error:'unknown post action', action: action});
  }catch(err){
    console.error('doPost error', err);
    return contentJson({ok:false, error: String(err)});
  }
}

/* ---------- End of file ---------- */
