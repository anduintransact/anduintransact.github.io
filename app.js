/**
 * The pre-boarding page. The link is `https://anduintransact.github.io/#<token>`: the token
 * stays in the fragment, which the browser never sends to the host, and goes to the API in a
 * header. The page draws itself from what `GET /state` answers: the e-mail gate first, then
 * one step per document to read and sign, and a last step with the questions to answer.
 *
 * The layout is the design handoff "onboarding portal (2a)": a top bar with the step
 * progress, the document on a grey canvas to the left, and an action panel to the right
 * that names the step, shows whether it is signed, and carries Back / Continue.
 *
 * Plain browser JavaScript, one module, no build step: the file is served as written. PDF.js
 * (vendored under vendor/pdfjs) draws each document so the person signs on the paper
 * itself, the way an e-signing tool shows a signing field — a browser's own PDF viewer
 * cannot take an overlay.
 *
 * `#preview` instead of a token is HR's preview from HiveFin's invite dialog: the page waits
 * for its data from the frame's parent and never calls the API.
 */

import * as pdfjs from './vendor/pdfjs/pdf.js'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.js', import.meta.url).href

const API = document.querySelector('meta[name="api-base"]').content.replace(/\/$/, '')
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const $ = (id) => document.getElementById(id)
const el = (tag, attrs, children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children || []) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  return node
}
/** One of the icons drawn once in index.html, at the given size. */
const icon = (name, size) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'ic')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', '#i-' + name)
  svg.appendChild(use)
  return svg
}

// ---- session: kept for this tab only, so a reload within two hours needs no second unlock --

const token = location.hash.slice(1)
const PREVIEW = token === 'preview'
// A new link pasted into a tab already on this page changes only the fragment, which does not
// reload the page: start over with the new token instead of keeping the old one.
window.addEventListener('hashchange', () => location.reload())
const store = {
  get() { try { return sessionStorage.getItem('s:' + token) } catch { return null } },
  set(v) { try { sessionStorage.setItem('s:' + token, v) } catch { /* private mode: ask again next time */ } },
  clear() { try { sessionStorage.removeItem('s:' + token) } catch { /* nothing to clear */ } },
}

function headers(json) {
  const h = { 'x-invite-token': token }
  const s = store.get()
  if (s) h.authorization = 'Bearer ' + s
  if (json) h['content-type'] = 'application/json'
  return h
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method, headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  return { ok: res.ok, status: res.status, data }
}

// ---- the screens ----------------------------------------------------------------------------

let stopAurora = null

/** Shows one screen. The top bar is on every screen but the gate; the aurora runs only there. */
function show(id) {
  for (const s of ['loading', 'message', 'gate', 'form-wrap']) $(s).hidden = s !== id
  $('topbar').hidden = id === 'gate'
  if (id !== 'gate' && stopAurora) { stopAurora(); stopAurora = null }
}

function message(title, text) {
  $('message-title').textContent = title
  $('message-text').textContent = text
  show('message')
}

const MESSAGES = {
  invalid: ['This link is no longer valid', 'This link does not exist or has expired. Please contact HR for a new one.'],
  submitted: ['We have received your form', 'This form was already submitted. HR will contact you if anything is missing.'],
  locked: ['This link is locked', 'This link has been locked after too many wrong e-mail attempts. Please contact HR for a new one.'],
  busy: ['Try again later', 'Too many requests. Please wait a few minutes and open the link again.'],
  down: ['Could not open the form', 'The service did not answer. Please try again in a few minutes.'],
}

async function load() {
  const res = await call('GET', '/state')
  const status = res.data && res.data.status
  if (status === 'open') return renderForm(res.data)
  if (status === 'gate') return renderGate()
  const m = MESSAGES[status] || MESSAGES.down
  message(m[0], m[1])
}

function renderGate() {
  store.clear()
  show('gate')
  if (!stopAurora) stopAurora = startAurora($('aurora'))
  $('email').focus()
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = $('gate-form')
  const status = $('gate-status')
  const button = $('go')
  const email = $('email').value.trim()
  status.textContent = ''
  form.classList.remove('bad')
  if (!/\S+@\S+\.\S+/.test(email)) {
    form.classList.add('bad')
    status.textContent = 'Enter the e-mail address this link was sent to.'
    return
  }
  button.disabled = true
  try {
    const res = await call('POST', '/unlock', { email })
    if (res.ok && res.data && res.data.session) {
      store.set(res.data.session)
      show('loading')
      await load()
      return
    }
    form.classList.add('bad')
    if (res.status === 403) status.textContent = 'That e-mail does not match the address this link was sent to.'
    else if (res.status === 423) status.textContent = 'This link has been locked after too many wrong attempts. Please contact HR.'
    else if (res.status === 429) status.textContent = 'Too many attempts. Please wait a few minutes.'
    else if (res.status === 404) status.textContent = 'This link is no longer valid. Please contact HR for a new one.'
    else status.textContent = 'Could not check the address, please try again.'
  } catch {
    status.textContent = 'Could not connect, please try again.'
  } finally {
    button.disabled = false
  }
})

/**
 * HiveFin's sign-in AuroraBackground shader (components/auth/AuroraBackground.tsx), sized to
 * the gate. Returns the function that stops it. Skipped, leaving the CSS gradients, when the
 * person asked for reduced motion or WebGL is not there.
 */
function startAurora(canvas) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
  if (!gl) return null
  const vs = 'attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}'
  const fs = `precision mediump float;uniform float iTime;uniform vec2 iResolution;
#define NUM_OCTAVES 3
float rand(vec2 n){return fract(sin(dot(n,vec2(12.9898,4.1414)))*43758.5453);}
float noise(vec2 p){vec2 ip=floor(p);vec2 u=fract(p);u=u*u*(3.0-2.0*u);float res=mix(mix(rand(ip),rand(ip+vec2(1.0,0.0)),u.x),mix(rand(ip+vec2(0.0,1.0)),rand(ip+vec2(1.0,1.0)),u.x),u.y);return res*res;}
float fbm(vec2 x){float v=0.0;float a=0.3;vec2 shift=vec2(100.0);mat2 rot=mat2(cos(0.5),sin(0.5),-sin(0.5),cos(0.50));for(int i=0;i<NUM_OCTAVES;++i){v+=a*noise(x);x=rot*x*2.0+shift;a*=0.4;}return v;}
vec4 tanh4(vec4 x){vec4 e=exp(2.0*x);return (e-1.0)/(e+1.0);}
void main(){vec2 shake=vec2(sin(iTime*1.2)*0.005,cos(iTime*2.1)*0.005);
vec2 p=((gl_FragCoord.xy+shake*iResolution.xy)-iResolution.xy*0.5)/iResolution.y*mat2(6.0,-4.0,4.0,6.0);
vec2 v;vec4 o=vec4(0.0);float f=2.0+fbm(p+vec2(iTime*5.0,0.0))*0.5;
for(float i=0.0;i<35.0;i++){v=p+cos(i*i+(iTime+p.x*0.08)*0.025+i*vec2(13.0,11.0))*3.5+vec2(sin(iTime*3.0+i)*0.003,cos(iTime*3.5-i)*0.003);
float tailNoise=fbm(v+vec2(iTime*0.5,i))*0.3*(1.0-(i/35.0));
vec4 auroraColors=vec4(0.1+0.3*sin(i*0.2+iTime*0.4),0.3+0.5*cos(i*0.3+iTime*0.5),0.7+0.3*sin(i*0.4+iTime*0.3),1.0);
vec4 c=auroraColors*exp(sin(i*i+iTime*0.8))/length(max(v,vec2(v.x*f*0.015,v.y*1.5)));
float thin=smoothstep(0.0,1.0,i/35.0)*0.6;o+=c*(1.0+tailNoise*0.8)*thin;}
o=tanh4(pow(o/100.0,vec4(1.6)));gl_FragColor=o*1.5;}`
  const compile = (src, type) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
  }
  const v = compile(vs, gl.VERTEX_SHADER), f = compile(fs, gl.FRAGMENT_SHADER)
  if (!v || !f) return null
  const prog = gl.createProgram()
  gl.attachShader(prog, v)
  gl.attachShader(prog, f)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const pos = gl.getAttribLocation(prog, 'position')
  gl.enableVertexAttribArray(pos)
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0)
  const tLoc = gl.getUniformLocation(prog, 'iTime'), rLoc = gl.getUniformLocation(prog, 'iResolution')
  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, canvas.clientWidth * dpr)
    canvas.height = Math.max(1, canvas.clientHeight * dpr)
    gl.viewport(0, 0, canvas.width, canvas.height)
  }
  size()
  const ro = window.ResizeObserver ? new ResizeObserver(size) : null
  if (ro) ro.observe(canvas)
  const t0 = Date.now()
  let raf = 0
  const loop = () => {
    gl.uniform1f(tLoc, (Date.now() - t0) * 0.001)
    gl.uniform2f(rLoc, canvas.width, canvas.height)
    gl.clearColor(0.043, 0.067, 0.125, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    raf = requestAnimationFrame(loop)
  }
  loop()
  return () => { cancelAnimationFrame(raf); if (ro) ro.disconnect() }
}

// ---- the form: one step per document, then the questions -------------------------------------

let inputs = []
let docs = []          // [{ n, label, note, panel, pages, where, spot, pdf, loaded, drawnAt, href }]
let steps = []         // [{ kind: 'doc', doc } | { kind: 'form' }]
let current = 0
let signature = null   // one signature image per person (drawn or typed), placed per document
let method = 'drawn'   // how `signature` was made: 'drawn' | 'typed'
let signatureAspect = 1 // width / height of the image, so a resized box keeps its shape
const placed = {}      // n → true once the person put the signature on that document
const signedAt = {}    // n → the moment it was first placed, shown as "Signed October 25, 2026"
let displayName = ''
let startDate = null
let submitted = false

/** "1 October 2026" from an ISO date; the date as given when it does not parse. */
function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}
/** "October 25, 2026": the day something was signed or sent, in the person's own time zone. */
function dayOf(date) {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function fieldBlock(f, draft) {
  const label = el('label', { for: f.key, text: f.label })
  if (f.optional) label.appendChild(el('span', { class: 'opt', text: ' (optional)' }))
  const input = el('input', {
    id: f.key, name: f.key, 'data-key': f.key, type: f.type, maxlength: String(f.max_length),
    autocomplete: f.autocomplete, inputmode: f.type === 'tel' ? 'tel' : null, required: !f.optional,
  })
  input.value = draft[f.key] || ''
  // Long answers get the row to themselves; short ones share a row.
  const wide = f.max_length > 60 || f.type === 'email'
  const block = el('div', { class: 'field' + (wide ? ' wide' : ''), 'data-field': f.key }, [label, input])
  if (f.hint) block.appendChild(el('small', { class: 'hint', text: f.hint }))
  block.appendChild(el('div', { class: 'err' }))
  return block
}

/** A document's step: its pages drawn by PDF.js on the canvas. The panel describes it. */
function documentPanel(d) {
  const pages = el('div', { class: 'pages' }, [el('div', { class: 'loading', text: 'Loading the document…' })])
  const panel = el('div', { class: 'panel', hidden: true }, [pages])
  return { n: d.n, label: d.label, note: d.note || null, panel, pages, where: d.signature, spot: null, pdf: d.pdf || null, loaded: null, drawnAt: null, href: null }
}

function renderForm(state) {
  displayName = state.display_name || ''
  startDate = state.start_date || null
  $('who-name').textContent = displayName
  $('who-avatar').textContent = (displayName.trim()[0] || '?').toUpperCase()
  $('who').hidden = false

  const sections = $('sections')
  sections.textContent = ''
  for (const step of state.steps) {
    const fields = state.fields.filter((f) => f.step === step.id)
    if (fields.length === 0) continue
    sections.appendChild(el('section', {}, [el('h2', { text: step.label }), el('div', { class: 'grid' }, fields.map((f) => fieldBlock(f, state.draft || {})))]))
  }
  inputs = Array.from(sections.querySelectorAll('input[data-key]'))
  inputs.forEach((i) => i.addEventListener('input', () => { saveDraftSoon(); updateSubmit() }))
  // Leaving a field saves at once; the draft the server holds is where we start from.
  inputs.forEach((i) => i.addEventListener('change', () => { saveDraft() }))
  lastSaved = JSON.stringify(collect())
  $('consent-text').textContent = state.consent_text
  $('consent').checked = false

  const panels = $('panels')
  panels.textContent = ''
  docs = state.documents.map(documentPanel)
  docs.forEach((d) => panels.appendChild(d.panel))
  steps = [...docs.map((doc) => ({ kind: 'doc', doc })), { kind: 'form' }]

  const list = $('steps')
  list.textContent = ''
  steps.forEach(() => list.appendChild(el('li')))
  $('progress').hidden = false

  $('banner').hidden = !PREVIEW
  show('form-wrap')
  go(0)
}

/** Shows step `i`: one panel on the canvas, the side panel and the buttons following it. */
function go(i) {
  current = Math.max(0, Math.min(steps.length - 1, i))
  steps.forEach((s, k) => {
    const panel = s.kind === 'doc' ? s.doc.panel : $('panel-form')
    panel.hidden = k !== current
  })
  $('status').textContent = ''
  $('back').hidden = current === 0
  $('next').hidden = current === steps.length - 1
  $('submit').hidden = current !== steps.length - 1
  updateSide()
  updateProgress()
  const step = steps[current]
  if (step.kind === 'doc') {
    // Drawn once the panel is visible: a hidden block has no width to draw to.
    if (step.doc.loaded) drawPages(step.doc)
    else if (!step.doc.started) { step.doc.started = true; renderDoc(step.doc) }
  }
  $('canvas').scrollTop = 0
  window.scrollTo({ top: 0 })
}

/** The side panel for the current step: name, state, links, the signature box or checklist. */
function updateSide() {
  const step = steps[current]
  if (!step) return
  $('side-step').textContent = `Step ${current + 1} of ${steps.length}`
  $('side-doc').hidden = step.kind !== 'doc'
  $('side-form').hidden = step.kind !== 'form'
  if (step.kind === 'form') {
    $('side-title').textContent = 'Your details'
    const list = $('checklist')
    list.textContent = ''
    docs.forEach((d, k) => {
      const done = !!placed[d.n]
      const circle = el('span', { class: 'circle' + (done ? ' done' : '') })
      if (done) circle.appendChild(icon('check', 12)); else circle.textContent = String(k + 1)
      list.appendChild(el('div', { class: 'row' }, [circle, el('span', { class: 'name', text: d.label }), el('span', { class: 'state', text: done ? 'Signed' : 'Not signed yet' })]))
    })
    list.hidden = docs.length === 0
    updateSubmit()
    return
  }
  const doc = step.doc
  const done = !!placed[doc.n]
  $('side-title').textContent = doc.label
  $('pill').classList.toggle('signed', done)
  $('pill-text').textContent = done ? 'Signed' : 'Not signed yet'
  // The links: HR's note about the document, if there is one, and the file to read offline.
  const links = $('side-doc').querySelector('.links')
  links.textContent = ''
  if (doc.note) {
    const about = el('div', { class: 'about', hidden: true }, doc.note.split(/\n\s*\n/).map((t) => t.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).map((t) => el('p', { text: t })))
    const toggle = el('button', { type: 'button', class: 'linkb', 'aria-expanded': 'false' }, [icon('help', 15), "What's this document?"])
    toggle.addEventListener('click', () => { about.hidden = !about.hidden; toggle.setAttribute('aria-expanded', String(!about.hidden)) })
    links.append(toggle, about)
  }
  if (doc.href) links.appendChild(el('a', { class: 'linkb', href: doc.href, download: `${doc.label}.pdf` }, [icon('download', 15), 'Download PDF']))
  $('sig-unsigned').hidden = done
  $('sig-signed').hidden = !done
  if (done) {
    $('sig-preview').src = signature
    $('signed-on').textContent = 'Signed ' + dayOf(signedAt[doc.n] || new Date())
  }
  // HR's preview walks every step without signing; the candidate must sign first.
  $('next').disabled = !done && !PREVIEW
}

/** The top bar's "Step N of M" and its segments: done, current, upcoming. */
function updateProgress() {
  $('step-text').textContent = `Step ${current + 1} of ${steps.length}`
  Array.from($('steps').children).forEach((li, k) => {
    const s = steps[k]
    const done = s.kind === 'doc' ? !!placed[s.doc.n] : submitted
    li.className = done ? 'done' : k === current ? 'current' : ''
  })
}

/** "Sign and submit" waits for every required answer and the consent, as the design asks. */
function updateSubmit() {
  const filled = inputs.every((i) => !i.required || i.value.trim() !== '')
  $('submit').disabled = PREVIEW || !filled || !$('consent').checked
}
$('consent').addEventListener('change', updateSubmit)

$('back').addEventListener('click', () => go(current - 1))
$('next').addEventListener('click', () => { if (!$('next').disabled) go(current + 1) })
$('jump').addEventListener('click', () => {
  const step = steps[current]
  if (step && step.kind === 'doc' && step.doc.spot) step.doc.spot.scrollIntoView({ behavior: 'smooth', block: 'center' })
})

// A narrower or wider window redraws the visible document at the new width.
let resizeTimer = null
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    const step = steps[current]
    if (step && step.kind === 'doc' && step.doc.loaded) drawPages(step.doc)
  }, 200)
})

// Draft: saved a few seconds after typing stops, when a field is left, and when the tab is
// hidden, so closing it loses nothing. Only what changed is sent: the API counts every call,
// and typing must not spend the budget the documents and the submit need.
let timer = null
let lastSaved = ''
function collect() {
  const out = {}
  inputs.forEach((i) => { out[i.getAttribute('data-key')] = i.value })
  return out
}
function saveDraftSoon() {
  if (PREVIEW) return
  clearTimeout(timer)
  timer = setTimeout(saveDraft, 4000)
}
async function saveDraft() {
  if (PREVIEW || submitted) return
  clearTimeout(timer)
  const values = collect()
  const json = JSON.stringify(values)
  if (json === lastSaved) return
  try {
    const res = await call('POST', '/draft', { values })
    if (res.ok) lastSaved = json
    // The session ran out while typing: say so now, not at submit, while the words are fresh.
    else if (res.status === 401) sessionExpired()
  } catch { /* the next pause tries again */ }
}
function sessionExpired() {
  clearTimeout(timer)
  message('Your session has expired', 'Please open the link again and enter your e-mail once more. What you typed before the session ended has been kept.')
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraft() })

// ---- the documents, drawn page by page, each with its signing spot ----------------------------

/**
 * Puts the signature on a document's spot. The first time, the box is fitted to the image
 * inside the marked spot, anchored on its bottom-left (the signature line); after that the
 * box the person set is kept, in PDF points, so a redraw at another width puts it back.
 */
function placeOn(doc) {
  if (!doc.spot || !signature) return
  if (!doc.box || doc.boxFor !== signature) {
    // Fitted inside the marked spot, as the stamp fits it, keeping the image's shape.
    const w = doc.where
    const width = Math.min(w.width, w.height * signatureAspect)
    doc.box = { page: w.page, x: w.x, y: w.y, width, height: width / signatureAspect }
    doc.boxFor = signature
  }
  const spot = doc.spot
  spot.textContent = ''
  spot.appendChild(el('img', { src: signature, alt: 'Your signature' }))
  spot.appendChild(el('span', { class: 'grip', title: 'Drag to resize' }))
  spot.classList.add('done')
  spot.title = 'Drag to move, drag the corner to resize, click to sign again'
  if (!doc.mock) layoutSpot(doc)
  if (!placed[doc.n]) signedAt[doc.n] = new Date()
  placed[doc.n] = true
  updateSide()
  updateProgress()
}

/** The spot's CSS box from its PDF box (or the marked spot before anything is placed). */
function layoutSpot(doc) {
  const b = doc.box && placed[doc.n] ? doc.box : doc.where
  const tab = doc.spot
  tab.style.left = (b.x * doc.scale) + 'px'
  tab.style.top = ((doc.pageHeight - b.y - b.height) * doc.scale) + 'px'
  tab.style.width = (b.width * doc.scale) + 'px'
  tab.style.height = (b.height * doc.scale) + 'px'
}

/** The box in PDF points, as HiveFin stamps it; null when the marked spot was left as is. */
function toPdfBox(doc) {
  return doc.box && placed[doc.n] ? { page: doc.box.page, x: doc.box.x, y: doc.box.y, width: doc.box.width, height: doc.box.height } : null
}

/**
 * Moving and resizing a placed signature with the pointer: dragging the body moves the box,
 * dragging the corner grip scales it (same shape), both kept on the page. A click with no
 * movement opens the dialog to sign again.
 */
function dragOn(doc, tab) {
  let start = null
  tab.addEventListener('pointerdown', (e) => {
    if (!placed[doc.n] || !doc.box) return
    const grip = e.target.classList.contains('grip')
    start = { x: e.clientX, y: e.clientY, box: { ...doc.box }, grip, moved: false }
    tab.setPointerCapture(e.pointerId)
    e.preventDefault()
  })
  tab.addEventListener('pointermove', (e) => {
    if (!start) return
    const dx = (e.clientX - start.x) / doc.scale
    const dy = (e.clientY - start.y) / doc.scale
    if (Math.abs(dx) + Math.abs(dy) > 2 / doc.scale) start.moved = true
    const b = start.box
    const pageW = doc.pageWidth, pageH = doc.pageHeight
    if (start.grip) {
      // The grip sits top-right: pulling it right or up grows the box from its bottom-left.
      const width = Math.min(Math.max(b.width + dx, 20), pageW - b.x)
      const height = Math.min(width / signatureAspect, pageH - b.y)
      doc.box = { ...b, width: Math.min(width, height * signatureAspect), height }
    } else {
      doc.box = {
        ...b,
        x: Math.min(Math.max(b.x + dx, 0), pageW - b.width),
        y: Math.min(Math.max(b.y - dy, 0), pageH - b.height),
      }
    }
    layoutSpot(doc)
  })
  const end = (e) => {
    if (!start) return
    const click = !start.moved
    start = null
    if (click && !e.target.classList.contains('grip')) openPad(doc)
  }
  tab.addEventListener('pointerup', end)
  tab.addEventListener('pointercancel', () => { start = null })
}

/** The "Sign here" tag on the signing field, with the pen before the words. */
function signHereTab() {
  const tab = el('button', { type: 'button', class: 'spot', text: 'Sign here' })
  tab.prepend(icon('pen', 15))
  return tab
}

function spotTab(doc, where, base, scale) {
  // PDF points, origin bottom-left, to CSS pixels from the top-left of the page.
  const tab = signHereTab()
  doc.scale = scale
  doc.pageWidth = base.width
  doc.pageHeight = base.height
  doc.spot = tab
  layoutSpot(doc)
  tab.addEventListener('click', () => { if (!placed[doc.n]) openPad(doc) })
  dragOn(doc, tab)
  if (placed[doc.n]) placeOn(doc)
  return tab
}

async function drawPages(doc) {
  const host = doc.pages
  const pdf = doc.loaded
  if (host.clientWidth === 0) return
  const width = Math.max(280, host.clientWidth)
  if (doc.drawnAt === width) return
  doc.drawnAt = width
  host.textContent = ''
  doc.spot = null
  for (let num = 1; num <= pdf.numPages; num++) {
    const page = await pdf.getPage(num)
    const base = page.getViewport({ scale: 1 })
    const scale = width / base.width
    const ratio = window.devicePixelRatio || 1
    const viewport = page.getViewport({ scale: scale * ratio })
    const canvas = el('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    canvas.style.width = width + 'px'
    canvas.style.height = Math.floor(viewport.height / ratio) + 'px'
    const wrap = el('div', { class: 'page' }, [canvas])
    wrap.style.width = width + 'px'
    host.appendChild(wrap)
    if (doc.where && doc.where.page === num - 1) wrap.appendChild(spotTab(doc, doc.where, base, scale))
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  }
  if (!doc.href) {
    // The same bytes the viewer drew, offered as a file to read offline.
    const bytes = await pdf.getData()
    doc.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    if (steps[current] && steps[current].doc === doc) updateSide()
  }
}

function renderDoc(doc) {
  const host = doc.pages
  if (PREVIEW && !doc.pdf) {
    // No PDF in hand: a blank page stands in, with the tab where it will be.
    const mock = el('div', { class: 'mock', text: 'The document appears here, with its signing spot.' })
    const tab = signHereTab()
    tab.style.cssText = 'left:12%;bottom:14%;width:150px;height:36px'
    tab.addEventListener('click', () => openPad(doc))
    doc.spot = tab
    doc.mock = true
    doc.scale = 1
    doc.pageWidth = 595
    doc.pageHeight = 842
    doc.where = doc.where || { page: 0, x: 72, y: 100, width: 150, height: 36 }
    mock.appendChild(tab)
    host.textContent = ''
    host.appendChild(mock)
    return
  }
  const source = doc.pdf
    ? { data: doc.pdf }
    : { url: API + '/doc/' + doc.n, httpHeaders: headers(false), withCredentials: false, disableRange: true, disableStream: true }
  pdfjs.getDocument(source).promise
    .then((pdf) => { doc.loaded = pdf; return drawPages(doc) })
    .catch(() => {
      host.textContent = ''
      host.appendChild(el('div', { class: 'loading', text: 'The document could not be shown. Please reload the page, or contact HR if it keeps failing.' }))
    })
}

// ---- the signature dialog: drawn once, placed per document ---------------------------------

const veil = $('veil')
const pad = $('sig')
const ctx = pad.getContext('2d')
const INK = '#0d3b8c'
let drawing = false
let dirty = false
let pending = null

function sizeCanvas() {
  const ratio = window.devicePixelRatio || 1
  const rect = pad.getBoundingClientRect()
  pad.width = Math.round(rect.width * ratio)
  pad.height = Math.round(rect.height * ratio)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.scale(ratio, ratio)
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = INK
  dirty = false
}
function openPad(doc) {
  pending = doc
  // A signature already made is reused with one click, as a saved signature is; the dialog
  // comes back only when there is none yet, or to sign again.
  if (signature && !placed[doc.n]) { placeOn(doc); return }
  veil.classList.add('open')
  if (!$('sig-name').value) $('sig-name').value = plainName(displayName)
  renderStyles()
  showTab(tab)
}
function closePad() { veil.classList.remove('open'); pending = null }

// --- typed: the name in a script font, drawn to a PNG like the pad's ---------------------
const STYLES = [
  { id: 'qwigley', family: 'Sig Qwigley', label: 'Style 1' },
  { id: 'kristi', family: 'Sig Kristi', label: 'Style 2' },
  { id: 'caveat', family: 'Sig Caveat', label: 'Style 3' },
  { id: 'apple', family: 'Sig Apple', label: 'Style 4' },
  { id: 'zeyada', family: 'Sig Zeyada', label: 'Style 5' },
]
let tab = 'draw'
let styleId = STYLES[0].id

/** The name without diacritics, the way a Vietnamese name is signed on an English letter. */
function plainName(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').trim()
}

function showTab(which) {
  tab = which
  $('tab-draw').classList.toggle('current', tab === 'draw')
  $('tab-type').classList.toggle('current', tab === 'type')
  $('tab-draw').setAttribute('aria-selected', String(tab === 'draw'))
  $('tab-type').setAttribute('aria-selected', String(tab === 'type'))
  $('pane-draw').hidden = tab !== 'draw'
  $('pane-type').hidden = tab !== 'type'
  if (tab === 'draw') sizeCanvas()
  else $('sig-name').focus()
}
$('tab-draw').addEventListener('click', () => showTab('draw'))
$('tab-type').addEventListener('click', () => showTab('type'))

function renderStyles() {
  const name = $('sig-name').value.trim() || 'Your name'
  const host = $('styles')
  host.textContent = ''
  for (const s of STYLES) {
    const button = el('button', { type: 'button', class: 'style' + (s.id === styleId ? ' current' : ''), role: 'radio', 'aria-checked': String(s.id === styleId) }, [
      el('span', { class: 'sample', text: name }), el('span', { class: 'which', text: s.label }),
    ])
    button.querySelector('.sample').style.fontFamily = `'${s.family}', cursive`
    button.addEventListener('click', () => { styleId = s.id; renderStyles() })
    host.appendChild(button)
  }
}
$('sig-name').addEventListener('input', renderStyles)

/** The typed name as a PNG data URL, sized to the text, transparent background. */
async function typedSignature(name, family) {
  const size = 96
  // Regular weight, spelled out: a browser must not synthesise bold for a single-weight face.
  const font = `400 ${size}px '${family}', cursive`
  try { await document.fonts.load(font, name) } catch { /* the fallback font draws instead */ }
  const c = document.createElement('canvas')
  const g = c.getContext('2d')
  g.font = font
  const m = g.measureText(name)
  const pad = size * 0.25
  c.width = Math.ceil(m.width + pad * 2)
  c.height = Math.ceil(size * 1.5)
  g.font = font
  g.fillStyle = INK
  g.textBaseline = 'alphabetic'
  g.fillText(name, pad, size * 1.05)
  return c.toDataURL('image/png')
}

/** The image's width / height, so a placed box can be scaled without distorting it. */
function aspectOf(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1)
    img.onerror = () => resolve(1)
    img.src = dataUrl
  })
}
function point(e) {
  const r = pad.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId)
  drawing = true
  const p = point(e)
  ctx.beginPath()
  ctx.moveTo(p.x, p.y)
})
pad.addEventListener('pointermove', (e) => {
  if (!drawing) return
  const p = point(e)
  ctx.lineTo(p.x, p.y)
  ctx.stroke()
  dirty = true
})
pad.addEventListener('pointerup', () => { drawing = false })
pad.addEventListener('pointercancel', () => { drawing = false })
$('clear').addEventListener('click', sizeCanvas)
$('cancel').addEventListener('click', closePad)
veil.addEventListener('click', (e) => { if (e.target === veil) closePad() })
$('apply').addEventListener('click', async () => {
  const status = $('pad-status')
  let next
  if (tab === 'draw') {
    if (!dirty) { status.textContent = 'Please sign in the box first.'; return }
    next = trimmedPad()
    method = 'drawn'
  } else {
    const name = $('sig-name').value.trim()
    if (!name) { status.textContent = 'Please type your name first.'; return }
    const style = STYLES.find((s) => s.id === styleId) || STYLES[0]
    next = await typedSignature(name, style.family)
    method = 'typed'
  }
  status.textContent = ''
  signature = next
  signatureAspect = await aspectOf(signature)
  // A new signature replaces the old one everywhere it was placed, refitted to each spot.
  for (const d of docs) { d.box = null; if (placed[d.n]) placeOn(d) }
  if (pending) placeOn(pending)
  closePad()
})

/** The drawing cropped to its ink, with a small margin, so the box fits the signature. */
function trimmedPad() {
  const w = pad.width, h = pad.height
  const data = ctx.getImageData(0, 0, w, h).data
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 0) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return pad.toDataURL('image/png')
  const margin = Math.round(Math.min(w, h) * 0.04)
  const sx = Math.max(0, minX - margin), sy = Math.max(0, minY - margin)
  const sw = Math.min(w, maxX + margin + 1) - sx, sh = Math.min(h, maxY + margin + 1) - sy
  const c = document.createElement('canvas')
  c.width = sw
  c.height = sh
  c.getContext('2d').drawImage(pad, sx, sy, sw, sh, 0, 0, sw, sh)
  return c.toDataURL('image/png')
}

// ---- submit ---------------------------------------------------------------------------------

function showErrors(errors) {
  for (const i of inputs) {
    const key = i.getAttribute('data-key')
    const box = i.closest('.field')
    const msg = errors && errors[key]
    box.classList.toggle('bad', !!msg)
    box.querySelector('.err').textContent = msg || ''
  }
  const first = $('sections').querySelector('.field.bad input')
  if (first) first.focus()
}

/** The last screen: a check, the start date, one card per document and one for the details. */
function renderDone() {
  submitted = true
  const now = new Date()
  $('form').hidden = true
  $('progress').hidden = true
  $('done-title').textContent = displayName ? `You're all set, ${displayName}` : "You're all set"
  const text = $('done-text')
  text.textContent = 'Thank you — your documents are signed and HR has your details.'
  if (startDate) text.append(' See you on ', el('b', { text: longDate(startDate) }), '.')
  const grid = $('done-grid')
  grid.textContent = ''
  const card = (name, meta, href) => {
    const parts = [el('div', { class: 'tile' }, [icon('file', 16)]), el('div', {}, [el('div', { class: 'name', text: name }), el('div', { class: 'meta', text: meta })])]
    if (href) parts.push(el('a', { class: 'linkb', href, download: `${name}.pdf` }, [icon('download', 13), 'Download PDF']))
    return el('div', { class: 'done-card' }, parts)
  }
  docs.forEach((d) => grid.appendChild(card(d.label, 'Signed ' + dayOf(signedAt[d.n] || now), d.href)))
  grid.appendChild(card('Your details', 'Submitted ' + dayOf(now), null))
  $('done').hidden = false
  window.scrollTo(0, 0)
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault()
  if (PREVIEW) return
  const status = $('status')
  const submit = $('submit')
  status.textContent = ''
  showErrors({})
  const unsigned = docs.filter((d) => !placed[d.n])
  if (unsigned.length) {
    // Back to the first document still unsigned, with the reason under its buttons.
    go(steps.findIndex((s) => s.kind === 'doc' && s.doc === unsigned[0]))
    status.textContent = 'Please sign this document where it says "Sign here" before submitting.'
    return
  }
  if (!$('consent').checked) { status.textContent = 'Please tick the confirmation before submitting.'; return }
  submit.disabled = true
  try {
    const res = await call('POST', '/submit', {
      values: collect(), signature_png: signature, signature_method: method,
      placed: docs.map((d) => ({ n: d.n, box: toPdfBox(d) })), consent: true,
    })
    if (res.ok) {
      clearTimeout(timer)
      renderDone()
      return
    }
    submit.disabled = false
    if (res.status === 401) { sessionExpired(); return }
    if (res.data && res.data.errors) { showErrors(res.data.errors); status.textContent = 'Please check the highlighted fields.' }
    else status.textContent = (res.data && res.data.error) || 'Could not submit, please try again.'
  } catch {
    submit.disabled = false
    status.textContent = 'Could not connect, please try again.'
  }
})

// ---- start ----------------------------------------------------------------------------------

if (PREVIEW) {
  // HiveFin's invite dialog frames this page and hands it the data the real invite would
  // carry, PDFs included, so HR previews the page itself. Only the frame's parent is heard.
  let announce = null
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== 'onboarding-preview') return
    clearInterval(announce)
    const state = e.data.state
    const pdfs = e.data.documents || []
    state.documents = (state.documents || []).map((d) => {
      const hit = pdfs.find((p) => p.n === d.n)
      const bytes = hit && hit.pdf_base64 ? Uint8Array.from(atob(hit.pdf_base64), (c) => c.charCodeAt(0)) : null
      return { ...d, pdf: bytes, signature: (hit && hit.signature) || d.signature }
    })
    renderForm(state)
  })
  // Announced until the data arrives: the dialog may start listening after the frame loaded.
  const ready = () => window.parent.postMessage({ type: 'onboarding-preview-ready' }, '*')
  ready()
  announce = setInterval(ready, 500)
  setTimeout(() => clearInterval(announce), 20_000)
} else if (!TOKEN_RE.test(token)) {
  message('This link is incomplete', 'Please copy the whole link from the e-mail HR sent you, or ask HR to send it again.')
} else {
  load().catch(() => message(MESSAGES.down[0], MESSAGES.down[1]))
}
