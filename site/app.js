const STORE_KEY = 'rk-theme'
const root = document.documentElement

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches
const currentTheme = () => root.dataset.theme || (systemDark() ? 'dark' : 'light')

document.getElementById('theme').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark'
  root.dataset.theme = next
  try { localStorage.setItem(STORE_KEY, next) } catch (e) {}
})

const nav = document.getElementById('nav')
const burger = document.getElementById('burger')
const setMenu = open => {
  nav.classList.toggle('is-open', open)
  burger.setAttribute('aria-expanded', String(open))
}
burger.addEventListener('click', () => setMenu(!nav.classList.contains('is-open')))
nav.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false) })

const copyText = async text => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (e) {
    const ta = Object.assign(document.createElement('textarea'), { value: text })
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

document.querySelectorAll('.copy').forEach(btn => {
  btn.addEventListener('click', async () => {
    const text = btn.dataset.copy ?? btn.parentElement.querySelector('pre').innerText
    const ok = await copyText(text.trim())
    btn.textContent = ok ? 'Скопировано' : 'Не вышло'
    btn.classList.toggle('is-done', ok)
    setTimeout(() => { btn.textContent = 'Копировать'; btn.classList.remove('is-done') }, 1600)
  })
})

const chips = document.querySelectorAll('.chip')
const cmds = document.querySelectorAll('.cmd')
chips.forEach(chip => {
  chip.addEventListener('click', () => {
    const group = chip.dataset.group
    chips.forEach(c => {
      c.classList.toggle('is-on', c === chip)
      c.setAttribute('aria-selected', String(c === chip))
    })
    cmds.forEach(cmd => { cmd.hidden = group !== 'all' && cmd.dataset.group !== group })
  })
})

const links = new Map([...nav.querySelectorAll('a')].map(a => [a.getAttribute('href').slice(1), a]))
const spy = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return
    links.forEach(a => a.classList.remove('is-active'))
    links.get(entry.target.id)?.classList.add('is-active')
  })
}, { rootMargin: '-45% 0px -50% 0px' })
links.forEach((_, id) => { const el = document.getElementById(id); if (el) spy.observe(el) })

const revealables = document.querySelectorAll('.card, .stage, .step, .panel, .cmd, .guards li')
const reveal = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return
    entry.target.classList.add('is-in')
    reveal.unobserve(entry.target)
  })
}, { rootMargin: '0px 0px -8% 0px' })
revealables.forEach(el => { el.classList.add('reveal'); reveal.observe(el) })
