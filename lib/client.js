// Browser half of the DSH font-settings plugin.
//
// Contributes ONE row to Settings → General (the `settings.general.item` seat)
// that picks an interface font and a code font from the fonts installed on this
// machine, and applies the choice to the shell's own font tokens:
//
//   interface font -> --dsw-font-family   (documentElement inline style wins over
//                                          both the ui-theme :root rule and the
//                                          pre-bundle bootstrap default)
//   code font      -> --ds-font-family-code
//
// The catalog comes from the Host half (`/api/dsh-fonts/*`) because the browser
// cannot read the filesystem. The preference is owned by the Host too, with a
// localStorage mirror so a reload renders the chosen font before the fetch lands.
//
// The picker is a hand-drawn menu rather than a native <select>: an OS-drawn
// option list ignores the token system, so its surface would never match the
// shell's own dropdowns. The markup below mirrors the host menu (4px padded
// card, `--dsw-menu-surface-fill` + blur, elevation stroke, 34px radius-md rows
// with a trailing check) so the surface, separators and hover fill all line up.
window.__ModuleLoader__.load({
  id: '@igaozp/dsh-font-settings',
  factory: (require) => {
    const React = require('react')
    // `react-dom` is part of the shell's frozen browser module baseline, so the
    // floating menu can be portaled into the open settings dialog (staying in
    // the top layer) instead of being clipped by the panel's scroll container.
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const NS = 'settings.fonts'
    const UI_VAR = '--dsw-font-family'
    const CODE_VAR = '--ds-font-family-code'
    const CACHE_KEY = 'dsh-font-settings.v1'
    const STYLE_ID = 'dsh-font-settings-style'
    const MENU_MAX_HEIGHT = 328

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'fonts.title': '字体',
      'fonts.description': '界面字体应用于整个界面；代码字体用于代码块、行内代码与终端。',
      'fonts.uiLabel': '界面字体',
      'fonts.codeLabel': '代码字体',
      'fonts.systemDefault': '跟随系统默认',
      'fonts.loadFailed': '读取本机字体失败：{error}',
      'fonts.fetchFailed': '无法连接宿主字体服务：{error}',
      'fonts.saveFailed': '保存失败：{error}',
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'fonts.title': 'Fonts',
      'fonts.description': 'The interface font applies to the whole UI; the code font is used for code blocks, inline code and the terminal.',
      'fonts.uiLabel': 'Interface font',
      'fonts.codeLabel': 'Code font',
      'fonts.systemDefault': 'System default',
      'fonts.loadFailed': 'Could not read installed fonts: {error}',
      'fonts.fetchFailed': 'Host font service unreachable: {error}',
      'fonts.saveFailed': 'Save failed: {error}',
    }

    /**
     * Trigger chevron, drawn inline instead of importing another package's icon
     * component (a dynamic Client half has no type check, and a throwing
     * component would blank the slot). It strokes with `currentColor`, so its
     * color is whatever token the trigger already resolved to — no second,
     * hand-picked color that could drift from the theme.
     */
    function ChevronIcon(props) {
      return h('svg', {
        className: props && props.className,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      }, h('path', {
        d: 'M4.25 6.25 8 10l3.75-3.75',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    const CSS = `
.dshfonts_row { border-bottom: .5px solid var(--dsw-alias-border-l2); flex-direction: column; gap: 12px; padding: 16px 0; display: flex; }
.dshfonts_head { flex-direction: column; gap: 4px; display: flex; }
.dshfonts_title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 400; line-height: 22px; }
.dshfonts_description { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 400; line-height: 18px; }

/* One preference row: the label sits left and the selector is right-aligned,
   like the host's own preference rows. */
.dshfonts_field { align-items: center; gap: 8px; min-width: 0; display: flex; }
.dshfonts_label { color: var(--dsw-alias-label-secondary); flex: 0 0 84px; min-width: 0; font-size: 13px; font-weight: 400; line-height: 22px; }

/* Trigger: same 36px selector shape as the host's rows. An auto left margin
   anchors it to the right edge, and a FIXED width keeps the control the same
   size whether or not a family is selected — the placeholder must not render a
   stubby box next to a long family name. Long names ellipsize inside. */
.dshfonts_trigger { box-sizing: border-box; border: none; border-radius: var(--dsw-radius-md); background-color: var(--dsw-alias-bg-module-platform); flex: 0 0 auto; margin-left: auto; width: min(360px, 100%); height: 36px; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; appearance: none; padding: 0 12px; gap: 6px; font-size: 13px; line-height: 22px; display: inline-flex; align-items: center; }
.dshfonts_triggerText { min-width: 0; flex: 1; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
.dshfonts_triggerIcon { flex: none; width: 16px; height: 16px; color: var(--dsw-alias-label-secondary); transition: transform .12s var(--ds-ease-in-out); }
.dshfonts_trigger[aria-expanded="true"] .dshfonts_triggerIcon { transform: rotate(180deg); }
.dshfonts_trigger:hover:not(:disabled), .dshfonts_trigger[aria-expanded="true"] { background-color: var(--dsw-alias-interactive-bg-hover); }
.dshfonts_trigger:disabled { cursor: default; opacity: .55; }
.dshfonts_trigger:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }

/* Menu card: mirrors the host's MenuSurface + Menu list. */
.dshfonts_menu { position: fixed; z-index: 1100; box-sizing: border-box; border-radius: var(--dsw-radius-lg); padding: 4px; overflow-y: auto; overscroll-behavior: contain; --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); box-shadow: var(--dsw-elevation-prominent); background: var(--dsw-menu-surface-fill); backdrop-filter: var(--dsw-menu-backdrop-filter); -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter); isolation: isolate; }
.dshfonts_item { box-sizing: border-box; border: none; border-radius: var(--dsw-radius-md); background: transparent; width: 100%; min-height: 34px; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; align-items: center; gap: 6px; padding: 6px 8px; font-size: 13px; line-height: 20px; display: flex; }
.dshfonts_item:hover:not(:disabled), .dshfonts_item:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.dshfonts_itemLabel { min-width: 0; flex: 1; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
.dshfonts_check { flex: none; width: 14px; height: 14px; color: var(--dsw-alias-label-primary); }

/* Only shown when something actually goes wrong; there is no informational
   status line, so the row stays quiet in the normal case. */
.dshfonts_problem { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
`

    /** Quote a family name for use inside a CSS font-family token. */
    function cssStack(family) {
      return '"' + String(family).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    }

    /** Apply the two tokens to the document, which is what actually changes the UI. */
    function applyTokens(uiFont, codeFont) {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      if (!root || !root.style) return
      const set = (name, family) => {
        if (family) root.style.setProperty(name, cssStack(family))
        else root.style.removeProperty(name)
      }
      set(UI_VAR, uiFont)
      set(CODE_VAR, codeFont)
    }

    function readCache() {
      try {
        const raw = window.localStorage && window.localStorage.getItem(CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return null
        return {
          uiFont: typeof parsed.uiFont === 'string' ? parsed.uiFont : '',
          codeFont: typeof parsed.codeFont === 'string' ? parsed.codeFont : '',
        }
      } catch {
        return null
      }
    }

    function writeCache(value) {
      try {
        if (window.localStorage) window.localStorage.setItem(CACHE_KEY, JSON.stringify(value))
      } catch {
        // Private mode or a blocked storage partition: the host copy is authoritative.
      }
    }

    function installStyles(ctx) {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = 'dsh-font-settings'
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() })
    }

    function request(path, options) {
      return fetch(path, Object.assign({ headers: { accept: 'application/json' } }, options)).then((response) => {
        if (!response.ok) {
          return response
            .json()
            .catch(() => ({}))
            .then((body) => {
              throw new Error((body && body.error) || 'HTTP ' + response.status)
            })
        }
        return response.json()
      })
    }

    /**
     * Where to attach a floating menu. Inside a modal `<dialog>` the menu must
     * stay in that dialog (the top layer), so prefer the nearest open dialog and
     * fall back to the body.
     */
    function portalHost(anchor) {
      try {
        const dialog = anchor && anchor.closest ? anchor.closest('dialog[open]') : null
        if (dialog) return dialog
      } catch {
        // closest() unavailable: fall through to the body.
      }
      return document.body || document.documentElement
    }

    /** Position a floating card under its anchor, flipping above when short. */
    function placeMenu(menu, anchor) {
      const rect = anchor.getBoundingClientRect()
      const margin = 4
      const viewportW = window.innerWidth || 0
      const viewportH = window.innerHeight || 0
      const wanted = Math.min(menu.scrollHeight || MENU_MAX_HEIGHT, MENU_MAX_HEIGHT)
      const below = viewportH - rect.bottom - margin - 8
      const above = rect.top - margin - 8
      const openUp = below < Math.min(wanted, 160) && above > below

      // Wide enough for the family names, at least as wide as the trigger.
      menu.style.minWidth = Math.round(rect.width) + 'px'
      menu.style.maxWidth = Math.round(Math.max(rect.width, Math.min(viewportW - 16, 400))) + 'px'
      menu.style.maxHeight = Math.min(wanted, Math.max(120, openUp ? above : below)) + 'px'
      // Centered on the trigger, then clamped into the viewport.
      const width = menu.offsetWidth || rect.width
      const centered = rect.left + (rect.width - width) / 2
      menu.style.left = Math.round(Math.max(8, Math.min(centered, viewportW - width - 8))) + 'px'
      menu.style.top = openUp
        ? Math.round(rect.top - margin - menu.offsetHeight) + 'px'
        : Math.round(rect.bottom + margin) + 'px'
    }

    function apply(ctx) {
      const locale = ctx.locale
      const t = locale.bind(NS)
      ctx.effect(() => locale.register(NS, { zh, en }), 'font-settings: row dictionary')
      installStyles(ctx)

      /** A trailing check, matching the host menu's selection marker. */
      function CheckIcon() {
        return h('svg', {
          className: 'dshfonts_check',
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        }, h('path', {
          d: 'M3.5 8.5 6.5 11.5 12.5 4.75',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
      }

      /**
       * One preference row: the label and the trigger on the same line, plus a
       * hand-drawn menu. The trigger renders its value in the selected family, so
       * the closed control is its own preview.
       */
      function FontField(props) {
        const { label, value, fonts, disabled, monospace, onPick } = props
        const anchorRef = React.useRef(null)
        const menuRef = React.useRef(null)
        const [open, setOpen] = React.useState(false)
        const [activeIndex, setActiveIndex] = React.useState(-1)

        const selected = fonts.find((font) => font.family === value) || null
        const stack = value
          ? cssStack(value) + (monospace ? ', ui-monospace, monospace' : ', sans-serif')
          : undefined
        const text = !value
          ? t('fonts.systemDefault')
          : (selected && selected.localized ? selected.localized : value)

        // Rows: the system default first, then every installed family.
        const rows = React.useMemo(() => {
          return [{ family: '', localized: '', text: t('fonts.systemDefault') }].concat(
            fonts.map((font) => ({
              family: font.family,
              localized: font.localized || '',
              text: font.localized ? font.family + '（' + font.localized + '）' : font.family,
            })),
          )
        }, [fonts, t])

        const close = React.useCallback((focusTrigger) => {
          setOpen(false)
          setActiveIndex(-1)
          if (focusTrigger !== false && anchorRef.current) anchorRef.current.focus()
        }, [])

        const commit = React.useCallback((family) => {
          close(true)
          onPick(family)
        }, [close, onPick])

        // Outside click closes without stealing focus.
        React.useEffect(() => {
          if (!open) return undefined
          const onPointerDown = (event) => {
            const menu = menuRef.current
            const anchor = anchorRef.current
            if (menu && menu.contains(event.target)) return
            if (anchor && anchor.contains(event.target)) return
            close(false)
          }
          const onKey = (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              close(true)
            }
          }
          document.addEventListener('mousedown', onPointerDown, true)
          document.addEventListener('keydown', onKey, true)
          return () => {
            document.removeEventListener('mousedown', onPointerDown, true)
            document.removeEventListener('keydown', onKey, true)
          }
        }, [open, close])

        // Keep the card glued to the trigger while the panel scrolls or resizes.
        React.useEffect(() => {
          if (!open) return undefined
          const reposition = () => {
            if (menuRef.current && anchorRef.current) placeMenu(menuRef.current, anchorRef.current)
          }
          reposition()
          window.addEventListener('resize', reposition)
          window.addEventListener('scroll', reposition, true)
          return () => {
            window.removeEventListener('resize', reposition)
            window.removeEventListener('scroll', reposition, true)
          }
        }, [open])

        // Reveal the current row when the menu opens.
        React.useEffect(() => {
          if (!open) return
          const index = rows.findIndex((row) => row.family === value)
          setActiveIndex(index)
          const menu = menuRef.current
          if (!menu || index < 0) return
          const row = menu.children[index]
          if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
        }, [open, rows, value])

        function toggle() {
          if (disabled) return
          const next = !open
          setOpen(next)
          if (next && menuRef.current && anchorRef.current) placeMenu(menuRef.current, anchorRef.current)
        }

        function onTriggerKeyDown(event) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggle()
          }
        }

        function onMenuKeyDown(event) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const step = event.key === 'ArrowDown' ? 1 : -1
            setActiveIndex((current) => {
              const next = Math.max(0, Math.min(rows.length - 1, (current < 0 ? (step > 0 ? -1 : rows.length) : current) + step))
              const menu = menuRef.current
              const row = menu && menu.children[next]
              if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
              return next
            })
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            const row = rows[activeIndex]
            if (row) commit(row.family)
          }
        }

        const menu = open && !disabled
          ? h('div', {
            ref: menuRef,
            className: 'dshfonts_menu',
            role: 'listbox',
            'aria-label': label,
            onKeyDown: onMenuKeyDown,
          },
            rows.map((row, index) => h('button', {
              key: row.family === '' ? '__default' : 'f:' + row.family,
              type: 'button',
              role: 'option',
              tabIndex: -1,
              'aria-selected': row.family === value,
              className: 'dshfonts_item',
              'data-active': index === activeIndex ? '' : undefined,
              style: { fontFamily: row.family ? cssStack(row.family) + (monospace ? ', ui-monospace, monospace' : ', sans-serif') : undefined },
              onClick: () => commit(row.family),
              onMouseEnter: () => setActiveIndex(index),
            },
              h('span', { className: 'dshfonts_itemLabel' }, row.text),
              row.family === value ? h(CheckIcon) : null,
            )),
          )
          : null

        return h('div', { className: 'dshfonts_field' },
          // Plain text, NOT a <label for=...>: an associated label forwards its
          // clicks to the control, so clicking the text would open the menu.
          h('span', { className: 'dshfonts_label', title: label }, label),
          h('button', {
            ref: anchorRef,
            type: 'button',
            className: 'dshfonts_trigger',
            disabled,
            title: text,
            // The visible text is a sibling, so label the control directly.
            'aria-label': label,
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            onClick: toggle,
            onKeyDown: onTriggerKeyDown,
          },
            h('span', { className: 'dshfonts_triggerText', style: stack ? { fontFamily: stack } : undefined }, text),
            h(ChevronIcon, { className: 'dshfonts_triggerIcon' }),
          ),
          menu ? ReactDOM.createPortal(menu, portalHost(anchorRef.current)) : null,
        )
      }

      // ---- observable store: the row subscribes through useSyncExternalStore ----
      const cached = readCache() || { uiFont: '', codeFont: '' }
      let snapshot = {
        uiFont: cached.uiFont,
        codeFont: cached.codeFont,
        uiFonts: [],
        codeFonts: [],
        count: 0,
        persistedTo: null,
        phase: 'loading',
        busy: false,
        notice: null,
        noticeError: false,
        error: null,
      }
      const listeners = new Set()

      function publish(patch) {
        snapshot = Object.assign({}, snapshot, patch)
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // A broken subscriber must not stop the others.
          }
        }
      }

      const store = {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() {
          return snapshot
        },
      }

      /**
       * Turn a state response into display fields. The status line is derived
       * here rather than trusting `persistError` verbatim: when the host reports
       * a durable destination (`settings` or `storage`) the choice IS saved, and
       * any lower-level complaint about the preferred store is an internal
       * detail that must not be shown as a failure.
       */
      function statePatch(data) {
        const persistedTo = data.persistedTo || null
        const durable = persistedTo === 'settings' || persistedTo === 'storage'
        const failure = !durable && data.persistError ? String(data.persistError) : null
        return {
          persistedTo,
          notice: failure,
          noticeError: Boolean(failure),
        }
      }

      async function loadFonts() {
        publish({ busy: true })
        try {
          const data = await request('/api/dsh-fonts/fonts')
          const fonts = Array.isArray(data.fonts) ? data.fonts : []
          publish({
            uiFonts: fonts,
            codeFonts: Array.isArray(data.codeFonts) ? data.codeFonts : fonts,
            count: typeof data.count === 'number' ? data.count : fonts.length,
            phase: 'ready',
            busy: false,
            error: null,
          })
        } catch (error) {
          publish({
            phase: 'error',
            busy: false,
            error: String((error && error.message) || error),
          })
        }
      }

      async function refreshState() {
        try {
          const data = await request('/api/dsh-fonts/state')
          const next = {
            uiFont: typeof data.uiFont === 'string' ? data.uiFont : '',
            codeFont: typeof data.codeFont === 'string' ? data.codeFont : '',
          }
          applyTokens(next.uiFont, next.codeFont)
          writeCache(next)
          publish(Object.assign({}, next, {
            count: typeof data.count === 'number' ? data.count : snapshot.count,
          }, statePatch(data)))
        } catch (error) {
          // The cached choice is already applied; surface the transport failure only.
          publish({
            notice: t('fonts.fetchFailed', { error: String((error && error.message) || error) }),
            noticeError: true,
          })
        }
      }

      // Paint the cached preference before any network work so a reload never
      // flashes the default stack.
      applyTokens(snapshot.uiFont, snapshot.codeFont)

      async function choose(field, value) {
        const previous = { uiFont: snapshot.uiFont, codeFont: snapshot.codeFont }
        const optimistic = Object.assign({}, previous, { [field]: value })
        // Optimistic: the click must repaint immediately.
        applyTokens(optimistic.uiFont, optimistic.codeFont)
        writeCache(optimistic)
        publish(Object.assign({}, optimistic, { busy: true, notice: null }))
        try {
          const data = await request('/api/dsh-fonts/state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ [field]: value }),
          })
          const next = {
            uiFont: typeof data.uiFont === 'string' ? data.uiFont : optimistic.uiFont,
            codeFont: typeof data.codeFont === 'string' ? data.codeFont : optimistic.codeFont,
          }
          applyTokens(next.uiFont, next.codeFont)
          writeCache(next)
          publish(Object.assign({}, next, { busy: false }, statePatch(data)))
        } catch (error) {
          // Roll back so the UI never claims a choice the host rejected.
          applyTokens(previous.uiFont, previous.codeFont)
          writeCache(previous)
          publish(Object.assign({}, previous, {
            busy: false,
            notice: t('fonts.saveFailed', { error: String((error && error.message) || error) }),
            noticeError: true,
          }))
        }
      }

      function FontsRow() {
        const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
        React.useEffect(() => {
          loadFonts()
          refreshState()
        }, [])

        const loading = state.phase === 'loading'
        const disabled = loading || state.busy

        // No informational status line: the font count and "saved" state are
        // implementation detail the user does not need to read. Only a real
        // problem — fonts unreadable, or a rejected write — surfaces text.
        let problem = null
        if (state.phase === 'error') {
          problem = t('fonts.loadFailed', { error: state.error || '' })
        } else if (state.notice && state.noticeError) {
          problem = String(state.notice)
        }

        return h('div', { className: 'dshfonts_row' },
          h('div', { className: 'dshfonts_head' },
            h('h3', { className: 'dshfonts_title' }, t('fonts.title')),
            h('p', { className: 'dshfonts_description' }, t('fonts.description')),
          ),

          h(FontField, {
            key: 'ui',
            label: t('fonts.uiLabel'),
            value: state.uiFont,
            fonts: state.uiFonts,
            disabled,
            monospace: false,
            onPick: (value) => { choose('uiFont', value) },
          }),

          h(FontField, {
            key: 'code',
            label: t('fonts.codeLabel'),
            value: state.codeFont,
            fonts: state.codeFonts,
            disabled,
            monospace: true,
            onPick: (value) => { choose('codeFont', value) },
          }),

          problem ? h('p', { className: 'dshfonts_problem', role: 'status' }, problem) : null,
        )
      }

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'fonts',
        order: 12,
        locale: NS,
      }, FontsRow))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
