/**
 * The pre-boarding page. The link is `https://anduintransact.github.io/#<token>`: the token
 * stays in the fragment, which the browser never sends to the host, and goes to the API in a
 * header. The page draws itself from what `GET /state` answers: the e-mail gate first, then
 * the questions, the documents with a "Sign here" tab on each, the consent line.
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

// ---- the form ------------------------------------------------------------------------------

let inputs = []
let docs = []          // [{ n, block, spot, where, pdf }]
let signature = null   // one drawing per person, placed per document
const placed = {}

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

function renderForm(state) {
  const start = state.start_date ? ' Expected start date: ' : ''
  const greeting = $('greeting')
  greeting.textContent = ''
  greeting.append('Hello ', el('strong', { text: state.display_name }), '.')
  if (start) greeting.append(start, el('strong', { text: state.start_date }), '.')
  greeting.append(' Please fill in the details below, read the documents and sign, so Anduin can prepare your file before your first day.')

  const sections = $('sections')
  sections.textContent = ''
  for (const step of state.steps) {
    const fields = state.fields.filter((f) => f.step === step.id)
    if (fields.length === 0) continue
    sections.appendChild(el('section', {}, [el('h2', { text: step.label }), ...fields.map((f) => fieldBlock(f, state.draft || {}))]))
  }
  inputs = Array.from(sections.querySelectorAll('input[data-key]'))
  inputs.forEach((i) => i.addEventListener('input', saveDraftSoon))

  const list = $('doc-list')
  list.textContent = ''
  docs = []
  $('docs').hidden = state.documents.length === 0
  $('docs-hint').textContent = ''
  $('docs-hint').append(`Read ${state.documents.length > 1 ? 'each document' : 'the document'}, then click `, el('strong', { text: 'Sign here' }), ' on it to sign.')
  for (const d of state.documents) {
    const stateLine = el('span', { class: 'state', text: 'Not signed yet' })
    const pages = el('div', { class: 'pages' }, [el('div', { class: 'loading', text: 'Loading the document…' })])
    const block = el('div', { class: 'doc' }, [el('div', { class: 'head' }, [el('div', {}, [el('h3', { text: d.label }), stateLine])]), pages])
    list.appendChild(block)
    const doc = { n: d.n, block, pages, stateLine, where: d.signature, spot: null, pdf: d.pdf || null }
    docs.push(doc)
    renderDoc(doc)
  }

  $('consent-text').textContent = state.consent_text
  $('consent').checked = false
  $('submit').disabled = PREVIEW
  $('banner').hidden = !PREVIEW
  show('form-wrap')
}

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

function placeOn(doc) {
  if (!doc.spot || !signature) return
  doc.spot.textContent = ''
  doc.spot.appendChild(el('img', { src: signature, alt: 'Your signature' }))
  doc.spot.classList.add('done')
  doc.spot.title = 'Click to sign again'
  placed[doc.n] = true
  doc.block.classList.add('signed')
  doc.stateLine.textContent = 'Signed'
}

function spotTab(doc, where, base, scale) {
  // PDF points, origin bottom-left, to CSS pixels from the top-left of the page.
  const tab = el('button', { type: 'button', class: 'spot', text: 'Sign here' })
  tab.style.left = (where.x * scale) + 'px'
  tab.style.top = ((base.height - where.y - where.height) * scale) + 'px'
  tab.style.width = (where.width * scale) + 'px'
  tab.style.height = (where.height * scale) + 'px'
  tab.addEventListener('click', () => openPad(doc))
  doc.spot = tab
  if (placed[doc.n]) placeOn(doc)
  return tab
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
    mock.appendChild(tab)
    host.textContent = ''
    host.appendChild(mock)
    return
  }
  const width = Math.max(280, host.clientWidth - 24)
  const source = doc.pdf
    ? { data: doc.pdf }
    : { url: API + '/doc/' + doc.n, httpHeaders: headers(false), withCredentials: false, disableRange: true, disableStream: true }
  pdfjs.getDocument(source).promise
    .then(async (pdf) => {
      host.textContent = ''
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
    })
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
  // A drawing already made is reused with one click, as a saved signature is; the dialog
  // comes back only when there is none yet, or to sign again.
  if (signature && !placed[doc.n]) { placeOn(doc); return }
  veil.classList.add('open')
  sizeCanvas()
}
function closePad() { veil.classList.remove('open'); pending = null }
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
$('apply').addEventListener('click', () => {
  const status = $('status')
  if (!dirty) { status.textContent = 'Please sign in the box first.'; return }
  status.textContent = ''
  signature = pad.toDataURL('image/png')
  // A new drawing replaces the old one everywhere it was placed: one signature per person.
  for (const d of docs) if (placed[d.n]) placeOn(d)
  if (pending) placeOn(pending)
  closePad()
})

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
    status.textContent = 'Please sign each document where it says "Sign here".'
    unsigned[0].block.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  if (!$('consent').checked) { status.textContent = 'Please tick the confirmation before submitting.'; return }
  submit.disabled = true
  try {
    const res = await call('POST', '/submit', {
      values: collect(), signature_png: signature, signature_method: 'drawn',
      placed: docs.map((d) => d.n), consent: true,
    })
    if (res.ok) {
      clearTimeout(timer)
      $('form').hidden = true
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
