/**
 * The pre-boarding page. The link is `https://anduintransact.github.io/#<token>`: the token
 * stays in the fragment, which the browser never sends to the host, and goes to the API in a
 * header. The page draws itself from what `GET /state` answers: the e-mail gate first, then
 * one step per document to read and sign, and a last step with the questions to answer.
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

// ---- session: kept for this tab only, so a reload within two hours needs no second unlock --

const token = location.hash.slice(1)
const PREVIEW = token === 'preview'
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

// ---- the three screens ----------------------------------------------------------------------

function show(id) {
  for (const s of ['loading', 'message', 'gate', 'form-wrap']) $(s).hidden = s !== id
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
  $('email').focus()
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const status = $('gate-status')
  const button = $('go')
  status.textContent = ''
  button.disabled = true
  try {
    const res = await call('POST', '/unlock', { email: $('email').value })
    if (res.ok && res.data && res.data.session) {
      store.set(res.data.session)
      show('loading')
      await load()
      return
    }
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

// ---- the form: one step per document, then the questions -------------------------------------

let inputs = []
let docs = []          // [{ n, label, panel, pages, stateLine, counter, jump, download, where, spot, pdf, loaded, drawnAt }]
let steps = []         // [{ kind: 'doc', doc } | { kind: 'form' }]
let current = 0
let signature = null   // one signature image per person (drawn or typed), placed per document
let method = 'drawn'   // how `signature` was made: 'drawn' | 'typed'
let signatureAspect = 1 // width / height of the image, so a resized box keeps its shape
const placed = {}      // n → true once the person put the signature on that document
let displayName = ''

function fieldBlock(f, draft) {
  const label = el('label', { for: f.key, text: f.label })
  if (f.optional) label.appendChild(el('span', { class: 'hint inline', text: ' (optional)' }))
  const input = el('input', {
    id: f.key, name: f.key, 'data-key': f.key, type: f.type, maxlength: String(f.max_length),
    autocomplete: f.autocomplete, inputmode: f.type === 'tel' ? 'tel' : null, required: !f.optional,
  })
  input.value = draft[f.key] || ''
  const block = el('div', { class: 'field', 'data-field': f.key }, [label, input])
  if (f.hint) block.appendChild(el('small', { class: 'hint', text: f.hint }))
  block.appendChild(el('div', { class: 'err' }))
  return block
}

/** A document's step: its title and state, a toolbar, and the pages drawn by PDF.js. */
function documentPanel(d) {
  const stateLine = el('span', { class: 'state', text: 'Not signed yet' })
  const pages = el('div', { class: 'pages' }, [el('div', { class: 'loading', text: 'Loading the document…' })])
  const counter = el('span', { class: 'counter' })
  const jump = el('button', { type: 'button', class: 'link', text: 'Go to signature', hidden: true })
  const download = el('a', { class: 'link', text: 'Download PDF ↓', download: `${d.label}.pdf`, hidden: true })
  const tools = el('div', { class: 'tools' }, [counter, el('span', { class: 'grow' }), jump, download])
  const head = el('div', { class: 'head' }, [el('div', {}, [el('h3', { text: d.label }), stateLine])])
  const hint = el('p', { class: 'hint', text: 'Read the document, then click Sign here on it to sign. You can download it to read offline.' })
  hint.style.margin = '-4px 0 12px'
  const parts = [head, hint]
  if (d.note) {
    // HR's plain-language note from the document type: what it is and why it is asked for.
    parts.push(el('details', { class: 'about' }, [el('summary', { text: "What's this document?" }), el('p', { text: d.note })]))
  }
  const panel = el('div', { class: 'panel', hidden: true }, [el('section', { class: 'doc' }, [...parts, tools, pages])])
  const doc = { n: d.n, label: d.label, panel, pages, stateLine, counter, jump, download, where: d.signature, spot: null, pdf: d.pdf || null, loaded: null, drawnAt: null }
  jump.addEventListener('click', () => { if (doc.spot) doc.spot.scrollIntoView({ behavior: 'smooth', block: 'center' }) })
  pages.addEventListener('scroll', () => updateCounter(doc), { passive: true })
  return doc
}

function renderForm(state) {
  displayName = state.display_name || ''
  const greeting = $('greeting')
  greeting.textContent = ''
  greeting.append('Hello ', el('strong', { text: state.display_name }), '.')
  if (state.start_date) greeting.append(' Expected start date: ', el('strong', { text: state.start_date }), '.')
  greeting.append(state.documents.length > 0
    ? ' Please read and sign each document, then fill in your details, so Anduin can prepare your file before your first day.'
    : ' Please fill in the details below, so Anduin can prepare your file before your first day.')

  const sections = $('sections')
  sections.textContent = ''
  for (const step of state.steps) {
    const fields = state.fields.filter((f) => f.step === step.id)
    if (fields.length === 0) continue
    sections.appendChild(el('section', {}, [el('h2', { text: step.label }), ...fields.map((f) => fieldBlock(f, state.draft || {}))]))
  }
  inputs = Array.from(sections.querySelectorAll('input[data-key]'))
  inputs.forEach((i) => i.addEventListener('input', saveDraftSoon))
  $('consent-text').textContent = state.consent_text
  $('consent').checked = false

  const panels = $('panels')
  panels.textContent = ''
  docs = state.documents.map(documentPanel)
  docs.forEach((d) => panels.appendChild(d.panel))
  steps = [...docs.map((doc) => ({ kind: 'doc', doc })), { kind: 'form' }]

  const list = $('steps')
  list.textContent = ''
  list.hidden = steps.length === 1
  steps.forEach((s, i) => {
    const name = s.kind === 'doc' ? s.doc.label : 'Your details'
    const button = el('button', { type: 'button' }, [el('span', { class: 'num', text: String(i + 1) }), el('span', { class: 'name', text: name })])
    button.addEventListener('click', () => go(i))
    list.appendChild(el('li', {}, [button]))
  })

  $('banner').hidden = !PREVIEW
  $('submit').disabled = PREVIEW
  show('form-wrap')
  go(0)
}

/** Shows step `i`: one panel at a time, the stepper and the buttons following it. */
function go(i) {
  current = Math.max(0, Math.min(steps.length - 1, i))
  steps.forEach((s, k) => {
    const panel = s.kind === 'doc' ? s.doc.panel : $('panel-form')
    panel.hidden = k !== current
  })
  Array.from($('steps').children).forEach((li, k) => {
    const s = steps[k]
    li.classList.toggle('current', k === current)
    li.classList.toggle('done', s.kind === 'doc' && !!placed[s.doc.n])
    li.querySelector('.num').textContent = s.kind === 'doc' && placed[s.doc.n] ? '✓' : String(k + 1)
  })
  $('back').hidden = current === 0
  $('next').hidden = current === steps.length - 1
  $('submit').hidden = current !== steps.length - 1
  $('status').textContent = ''
  const step = steps[current]
  if (step.kind === 'doc') {
    // Drawn once the panel is visible: a hidden block has no width to draw to.
    if (step.doc.loaded) drawPages(step.doc)
    else if (!step.doc.started) { step.doc.started = true; renderDoc(step.doc) }
  }
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

$('back').addEventListener('click', () => go(current - 1))
$('next').addEventListener('click', () => go(current + 1))

// A narrower or wider window redraws the visible document at the new width.
let resizeTimer = null
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    const step = steps[current]
    if (step && step.kind === 'doc' && step.doc.loaded) drawPages(step.doc)
  }, 200)
})

// Draft: saved a moment after typing stops, so closing the tab loses nothing.
let timer = null
function collect() {
  const out = {}
  inputs.forEach((i) => { out[i.getAttribute('data-key')] = i.value })
  return out
}
function saveDraftSoon() {
  if (PREVIEW) return
  clearTimeout(timer)
  timer = setTimeout(() => { call('POST', '/draft', { values: collect() }).catch(() => {}) }, 1500)
}

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
  placed[doc.n] = true
  doc.panel.querySelector('.doc').classList.add('signed')
  doc.stateLine.textContent = 'Signed'
  markSteps()
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

/** The stepper's ticks: a signed document shows a check instead of its number. */
function markSteps() {
  Array.from($('steps').children).forEach((li, k) => {
    const s = steps[k]
    const done = s.kind === 'doc' && !!placed[s.doc.n]
    li.classList.toggle('done', done)
    li.querySelector('.num').textContent = done ? '✓' : String(k + 1)
  })
}

function spotTab(doc, where, base, scale) {
  // PDF points, origin bottom-left, to CSS pixels from the top-left of the page.
  const tab = el('button', { type: 'button', class: 'spot', text: 'Sign here' })
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

/** The width a page is drawn at: the block's inner width, so the paper reads at full size. */
function pageWidth(host) {
  const style = getComputedStyle(host)
  return Math.max(280, host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
}

async function drawPages(doc) {
  const host = doc.pages
  const pdf = doc.loaded
  if (host.clientWidth === 0) return
  const width = pageWidth(host)
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
  doc.jump.hidden = !doc.spot
  updateCounter(doc)
  if (!doc.download.href) {
    // The same bytes the viewer drew, offered as a file to read offline.
    const bytes = await pdf.getData()
    doc.download.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    doc.download.hidden = false
  }
}

/** "Page x of y": the page whose top is closest above the middle of the viewer. */
function updateCounter(doc) {
  const pdf = doc.loaded
  if (!pdf) return
  const pages = Array.from(doc.pages.querySelectorAll('.page'))
  const middle = doc.pages.scrollTop + doc.pages.clientHeight / 2
  let page = 1
  pages.forEach((p, i) => { if (p.offsetTop <= middle) page = i + 1 })
  doc.counter.textContent = `Page ${page} of ${pdf.numPages}`
}

function renderDoc(doc) {
  const host = doc.pages
  if (PREVIEW && !doc.pdf) {
    // No PDF in hand: a blank page stands in, with the tab where it will be.
    const mock = el('div', { class: 'mock', text: 'The document appears here, with its signing spot.' })
    const tab = el('button', { type: 'button', class: 'spot', text: 'Sign here' })
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
    doc.jump.hidden = false
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
  ctx.strokeStyle = '#20394d'
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
  { id: 'vibes', family: 'Sig Vibes', label: 'Style 1' },
  { id: 'allura', family: 'Sig Allura', label: 'Style 2' },
  { id: 'dancing', family: 'Sig Dancing', label: 'Style 3' },
]
let tab = 'draw'
let styleId = STYLES[0].id

/** The name without diacritics, the way a Vietnamese name is signed on an English letter. */
function plainName(name) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').trim()
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
  const font = `${size}px '${family}', cursive`
  try { await document.fonts.load(font, name) } catch { /* the fallback font draws instead */ }
  const c = document.createElement('canvas')
  const g = c.getContext('2d')
  g.font = font
  const m = g.measureText(name)
  const pad = size * 0.25
  c.width = Math.ceil(m.width + pad * 2)
  c.height = Math.ceil(size * 1.5)
  g.font = font
  g.fillStyle = '#20394d'
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
  const status = $('status')
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
      $('form').hidden = true
      $('steps').hidden = true
      $('done').hidden = false
      window.scrollTo(0, 0)
      return
    }
    submit.disabled = false
    if (res.status === 401) { message('Your session has expired', 'Please open the link again and enter your e-mail once more. What you typed has been kept.'); return }
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
