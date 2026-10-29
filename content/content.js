/**
 * DomSlider - Content Script & Core Coordinator
 * Handles:
 * 1. Shadow DOM Sidebar injection (isolated from target page styles & scripts)
 * 2. Visual Drag & Drop reordering (prevents overlapping via DOM insertion flow)
 * 3. Individual Section Reset (restores original parent & DOM position)
 * 4. Pinning (screen edge sticky/fixed pin on scroll)
 * 5. URL-based chrome.storage.local persistence
 */

(function () {
  if (window.__DOMSLIDER_INITIALIZED__) return;
  window.__DOMSLIDER_INITIALIZED__ = true;

  // --- Configuration & State ---
  const STORAGE_KEY_PREFIX = "domslider_v1_";
  const pageKey = () => STORAGE_KEY_PREFIX + window.location.origin + window.location.pathname;

  const state = {
    editMode: false,
    sidebarOpen: false,
    hoveredElement: null,
    draggedElement: null,
    originalRegistry: new Map(), // Element -> { originalParent, originalNextSibling, placeholder, selector }
    pinnedElements: new Map(),   // Element -> { pinType: 'top'|'bottom', originalStyle, placeholder }
    dockedElements: new Map(),   // Element -> { originalParent, originalNextSibling, placeholder, title }
  };

  // --- Utility: Unique Selector Generation & Resolution ---
  function getElementSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.id && !el.id.startsWith("domslider")) {
      return "#" + CSS.escape(el.id);
    }
    const path = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.id && !current.id.startsWith("domslider")) {
        selector += "#" + CSS.escape(current.id);
        path.unshift(selector);
        break;
      } else {
        let sibling = current;
        let nth = 1;
        while ((sibling = sibling.previousElementSibling)) {
          if (sibling.tagName.toLowerCase() === current.tagName.toLowerCase()) {
            nth++;
          }
        }
        selector += `:nth-of-type(${nth})`;
      }
      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(" > ");
  }

  function resolveSelector(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  // Generate readable label for elements
  function getElementLabel(el) {
    if (!el) return "Element";
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").slice(0, 25);
    if (el.id) return `#${el.id}`;
    const heading = el.querySelector("h1, h2, h3, h4, header");
    if (heading && heading.textContent.trim()) {
      return heading.textContent.trim().slice(0, 25);
    }
    const text = el.textContent ? el.textContent.trim().slice(0, 25) : "";
    return text ? `<${el.tagName.toLowerCase()}> ${text}...` : `<${el.tagName.toLowerCase()}>`;
  }

  // --- Registration & Tracking ---
  function registerOriginalPosition(el) {
    if (state.originalRegistry.has(el)) return;
    const placeholder = document.createComment(`domslider-original-pos-${Date.now()}`);
    el.parentNode.insertBefore(placeholder, el);
    state.originalRegistry.set(el, {
      originalParent: el.parentNode,
      originalNextSibling: placeholder.nextSibling,
      placeholder: placeholder,
      selector: getElementSelector(el),
    });
  }

  // --- UI Elements Initialization ---
  let dropIndicator = null;
  let elementToolbar = null;
  let sidebarHost = null;
  let shadowRoot = null;

  function initUI() {
    // 1. Drop indicator line
    dropIndicator = document.createElement("div");
    dropIndicator.id = "domslider-drop-indicator";
    document.documentElement.appendChild(dropIndicator);

    // 2. Floating action toolbar
    elementToolbar = document.createElement("div");
    elementToolbar.id = "domslider-element-toolbar";
    elementToolbar.innerHTML = `
      <span id="domslider-toolbar-label" style="font-size: 11px; opacity: 0.8; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></span>
      <button id="domslider-btn-pin" title="Sayfa kayarken kenarda sabit tut">📌 Pinle</button>
      <button id="domslider-btn-dock" title="Sağ panele al">📥 Panele Al</button>
      <button id="domslider-btn-reset" class="danger" title="Orijinal yerine geri döndür">↺ Sıfırla</button>
    `;
    document.documentElement.appendChild(elementToolbar);

    setupToolbarEvents();

    // 3. Shadow DOM Sidebar
    sidebarHost = document.createElement("div");
    sidebarHost.id = "domslider-sidebar-host";
    shadowRoot = sidebarHost.attachShadow({ mode: "open" });
    buildSidebarDOM();
    document.documentElement.appendChild(sidebarHost);
  }

  // --- Floating Toolbar Logic ---
  let activeToolbarTarget = null;
  let hideToolbarTimeout = null;

  function setupToolbarEvents() {
    const pinBtn = elementToolbar.querySelector("#domslider-btn-pin");
    const dockBtn = elementToolbar.querySelector("#domslider-btn-dock");
    const resetBtn = elementToolbar.querySelector("#domslider-btn-reset");

    elementToolbar.addEventListener("mouseenter", () => {
      clearTimeout(hideToolbarTimeout);
    });

    elementToolbar.addEventListener("mouseleave", () => {
      hideToolbarTimeout = setTimeout(() => {
        if (!state.hoveredElement) {
          hideToolbar();
        }
      }, 300);
    });

    pinBtn.addEventListener("click", () => {
      if (!activeToolbarTarget) return;
      togglePin(activeToolbarTarget);
      updateToolbar(activeToolbarTarget);
    });

    dockBtn.addEventListener("click", () => {
      if (!activeToolbarTarget) return;
      dockToSidebar(activeToolbarTarget);
      hideToolbar();
    });

    resetBtn.addEventListener("click", () => {
      if (!activeToolbarTarget) return;
      resetElementToOriginal(activeToolbarTarget);
      hideToolbar();
    });
  }

  function showToolbarFor(el) {
    if (!state.editMode || !el || isDomSliderNode(el)) return;
    clearTimeout(hideToolbarTimeout);
    activeToolbarTarget = el;

    const rect = el.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    const labelSpan = elementToolbar.querySelector("#domslider-toolbar-label");
    const pinBtn = elementToolbar.querySelector("#domslider-btn-pin");
    labelSpan.textContent = getElementLabel(el);

    if (state.pinnedElements.has(el)) {
      pinBtn.classList.add("active");
      pinBtn.textContent = "📌 Pini Kaldır";
    } else {
      pinBtn.classList.remove("active");
      pinBtn.textContent = "📌 Pinle";
    }

    elementToolbar.style.display = "flex";

    // Elementin içine doğru yerleşim (iç üst-sol köşe veya biraz padding payı)
    // Eğer element çok küçükse (ör. yüksekliği 35px altı) veya üstteyse taşmayı önleyerek yerleştir
    const topPos = rect.top + scrollY + 4;
    const leftPos = rect.left + scrollX + 4;

    elementToolbar.style.top = `${Math.max(4, topPos)}px`;
    elementToolbar.style.left = `${Math.max(4, leftPos)}px`;
  }

  function hideToolbar() {
    elementToolbar.style.display = "none";
    activeToolbarTarget = null;
  }

  function updateToolbar(el) {
    if (activeToolbarTarget === el) {
      showToolbarFor(el);
    }
  }

  // --- Shadow DOM Sidebar UI & Styling ---
  function buildSidebarDOM() {
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        box-sizing: border-box;
      }
      *, *::before, *::after {
        box-sizing: border-box;
      }
      .sidebar-panel {
        pointer-events: auto;
        position: fixed;
        top: 0;
        right: 0;
        width: 380px;
        height: 100vh;
        background: #0f172a;
        color: #f1f5f9;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        box-shadow: -6px 0 24px rgba(0, 0, 0, 0.4);
        display: flex;
        flex-direction: column;
        transform: translateX(100%);
        transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), width 0.2s ease;
        z-index: 2147483647;
      }
      .sidebar-panel.open {
        transform: translateX(0);
      }
      .sidebar-panel.expanded {
        width: 540px;
      }
      .sidebar-header {
        padding: 14px 16px;
        background: #1e293b;
        border-bottom: 1px solid #334155;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .sidebar-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 700;
        font-size: 15px;
        color: #38bdf8;
      }
      .header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .btn-icon {
        background: #334155;
        border: none;
        color: #cbd5e1;
        cursor: pointer;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s, color 0.15s;
      }
      .btn-icon:hover {
        background: #475569;
        color: #ffffff;
      }
      .btn-icon.active {
        background: #0284c7;
        color: #ffffff;
      }
      .toggle-handle {
        pointer-events: auto;
        position: fixed;
        top: 40%;
        right: 0;
        transform: translateY(-50%);
        background: #0284c7;
        color: #ffffff;
        border: none;
        padding: 12px 7px;
        border-radius: 8px 0 0 8px;
        cursor: pointer;
        font-size: 12px;
        font-weight: bold;
        box-shadow: -2px 2px 10px rgba(0, 0, 0, 0.3);
        z-index: 2147483647;
        writing-mode: vertical-rl;
        letter-spacing: 1px;
        transition: background 0.2s, right 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .toggle-handle:hover {
        background: #0369a1;
      }
      .toggle-handle.sidebar-active {
        right: 380px;
      }
      .sidebar-panel.expanded ~ .toggle-handle.sidebar-active {
        right: 540px;
      }
      .sidebar-content {
        flex: 1;
        overflow-y: auto;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .section-card {
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 8px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .section-title {
        font-size: 13px;
        font-weight: 600;
        color: #94a3b8;
        display: flex;
        justify-content: space-between;
        align-items: center;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .badge {
        background: #334155;
        padding: 2px 6px;
        border-radius: 10px;
        font-size: 11px;
        color: #cbd5e1;
      }
      .dock-zone {
        min-height: 120px;
        max-height: 400px;
        overflow-y: auto;
        border: 2px dashed #475569;
        border-radius: 6px;
        padding: 10px;
        background: #0b1120;
        display: flex;
        flex-direction: column;
        gap: 10px;
        transition: border-color 0.15s, background-color 0.15s;
      }
      .dock-zone.drag-over {
        border-color: #38bdf8;
        background: rgba(56, 189, 248, 0.08);
      }
      .dock-placeholder {
        margin: auto;
        color: #64748b;
        font-size: 12px;
        text-align: center;
        padding: 20px 10px;
      }
      .dock-item {
        background: #1e293b;
        border: 1px solid #475569;
        border-radius: 6px;
        overflow: hidden;
      }
      .dock-item-header {
        background: #334155;
        padding: 6px 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: #e2e8f0;
      }
      .dock-item-content {
        padding: 8px;
        background: #0f172a;
        max-height: 180px;
        overflow: auto;
      }
      .item-actions {
        display: flex;
        gap: 4px;
      }
      .item-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 12px;
        padding: 2px 4px;
        border-radius: 3px;
      }
      .item-btn:hover {
        color: #f8fafc;
        background: #475569;
      }
      .pinned-list, .modified-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .list-item {
        background: #0f172a;
        border: 1px solid #334155;
        border-radius: 6px;
        padding: 8px 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .list-item-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 220px;
        color: #cbd5e1;
        font-size: 12px;
      }
      .sidebar-footer {
        padding: 12px 16px;
        border-top: 1px solid #334155;
        background: #1e293b;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .btn-primary {
        background: #0284c7;
        color: white;
        border: none;
        padding: 8px 14px;
        border-radius: 6px;
        font-weight: 500;
        cursor: pointer;
      }
      .btn-primary:hover {
        background: #0369a1;
      }
      .btn-secondary {
        background: #334155;
        color: #cbd5e1;
        border: none;
        padding: 8px 12px;
        border-radius: 6px;
        cursor: pointer;
      }
      .btn-secondary:hover {
        background: #475569;
        color: white;
      }
      .btn-reset-all {
        background: #7f1d1d;
        color: #fca5a5;
        border: none;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 11px;
        cursor: pointer;
      }
      .btn-reset-all:hover {
        background: #991b1b;
        color: #ffffff;
      }
    `;

    const container = document.createElement("div");
    container.innerHTML = `
      <button class="toggle-handle" id="btn-toggle-side" title="DomSlider Panelini Aç/Kapat">◧ DOMSLIDER</button>
      <div class="sidebar-panel" id="sidebar-panel">
        <div class="sidebar-header">
          <div class="sidebar-title">
            <span>⚡ DomSlider</span>
          </div>
          <div class="header-actions">
            <button class="btn-icon" id="btn-toggle-edit" title="Düzenleme Modu (Seç/Taşı)">✏️ Düzenleme Modu</button>
            <button class="btn-icon" id="btn-toggle-expand" title="Genişlet/Daralt">⇲</button>
            <button class="btn-icon" id="btn-close-sidebar" title="Kapat">✕</button>
          </div>
        </div>

        <div class="sidebar-content">
          <!-- Docked Area -->
          <div class="section-card">
            <div class="section-title">
              <span>Panele Çekilen Elementler</span>
              <span class="badge" id="docked-count">0</span>
            </div>
            <div class="dock-zone" id="sidebar-dock-zone">
              <div class="dock-placeholder" id="dock-placeholder">
                Sayfadaki herhangi bir elementi buraya sürükleyip bırakabilir veya element üzerindeki "Panele Al" butonuna basabilirsiniz.
              </div>
            </div>
          </div>

          <!-- Pinned Elements -->
          <div class="section-card">
            <div class="section-title">
              <span>Pinlenen Elementler (Ekran Kenarı)</span>
              <span class="badge" id="pinned-count">0</span>
            </div>
            <div class="pinned-list" id="pinned-list">
              <div style="color: #64748b; font-size: 12px; padding: 4px;">Henüz pinlenen element yok.</div>
            </div>
          </div>

          <!-- Reordered / Modified Registry -->
          <div class="section-card">
            <div class="section-title">
              <span>Değiştirilen Bölümler</span>
              <button class="btn-reset-all" id="btn-reset-all">Tümünü Sıfırla</button>
            </div>
            <div class="modified-list" id="modified-list">
              <div style="color: #64748b; font-size: 12px; padding: 4px;">Orijinal sıralama korunuyor.</div>
            </div>
          </div>
        </div>

        <div class="sidebar-footer">
          <span style="font-size: 11px; color: #64748b;">Değişiklikler bu URL için otomatik kaydedilir.</span>
          <button class="btn-secondary" id="btn-save-now">💾 Kaydet</button>
        </div>
      </div>
    `;

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(container);

    bindSidebarEvents(container);
  }

  function bindSidebarEvents(container) {
    const toggleBtn = container.querySelector("#btn-toggle-side");
    const closeBtn = container.querySelector("#btn-close-sidebar");
    const editBtn = container.querySelector("#btn-toggle-edit");
    const expandBtn = container.querySelector("#btn-toggle-expand");
    const resetAllBtn = container.querySelector("#btn-reset-all");
    const saveBtn = container.querySelector("#btn-save-now");
    const panel = container.querySelector("#sidebar-panel");
    const dockZone = container.querySelector("#sidebar-dock-zone");

    // Toggle Open/Close
    const toggleSidebar = (force) => {
      state.sidebarOpen = typeof force === "boolean" ? force : !state.sidebarOpen;
      panel.classList.toggle("open", state.sidebarOpen);
      toggleBtn.classList.toggle("sidebar-active", state.sidebarOpen);
    };

    toggleBtn.addEventListener("click", () => toggleSidebar());
    closeBtn.addEventListener("click", () => toggleSidebar(false));

    // Toggle Edit Mode
    editBtn.addEventListener("click", () => {
      setEditMode(!state.editMode);
    });

    // Expand width
    expandBtn.addEventListener("click", () => {
      panel.classList.toggle("expanded");
      expandBtn.textContent = panel.classList.contains("expanded") ? "⇱" : "⇲";
    });

    // Reset All
    resetAllBtn.addEventListener("click", () => {
      if (confirm("Bu sayfadaki tüm DOM taşımalarını ve pinleri orijinal haline döndürmek istiyor musunuz?")) {
        resetAllToOriginal();
      }
    });

    // Save
    saveBtn.addEventListener("click", () => {
      persistCurrentState();
      saveBtn.textContent = "✓ Kaydedildi";
      setTimeout(() => (saveBtn.textContent = "💾 Kaydet"), 1500);
    });

    // Dock Zone Drop Handling
    dockZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dockZone.classList.add("drag-over");
    });

    dockZone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dockZone.classList.remove("drag-over");
    });

    dockZone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dockZone.classList.remove("drag-over");
      if (state.draggedElement) {
        dockToSidebar(state.draggedElement);
      }
    });

    // Expose toggle globally for Chrome Action Message
    window.__DOMSLIDER_TOGGLE_SIDEBAR__ = toggleSidebar;
  }

  function setEditMode(enable) {
    state.editMode = enable;
    const editBtn = shadowRoot.querySelector("#btn-toggle-edit");
    if (editBtn) {
      editBtn.classList.toggle("active", state.editMode);
    }
    if (!state.editMode) {
      if (state.hoveredElement) {
        state.hoveredElement.classList.remove("domslider-inspect-hover");
        state.hoveredElement = null;
      }
      hideToolbar();
      hideDropIndicator();
    }
  }

  // Helper check: Is node part of DomSlider UI?
  function isDomSliderNode(node) {
    if (!node) return false;
    if (node === sidebarHost || node === dropIndicator || node === elementToolbar) return true;
    if (sidebarHost && sidebarHost.contains(node)) return true;
    if (elementToolbar && elementToolbar.contains(node)) return true;
    if (node.id && node.id.startsWith("domslider")) return true;
    return false;
  }

  // --- Drag & Drop Flow & Overlap Prevention ---
  let dropTargetInfo = null; // { targetElement, position: 'before'|'after' }

  function setupGlobalEvents() {
    // Mouse movement during edit mode
    document.addEventListener(
      "mousemove",
      (e) => {
        if (!state.editMode || state.draggedElement) return;

        // Toolbar üzerine gelindiğinde hedef elementi değiştirmeyi durdur
        if (elementToolbar && (elementToolbar === e.target || elementToolbar.contains(e.target))) {
          clearTimeout(hideToolbarTimeout);
          return;
        }

        const target = getEligibleElementUnder(e.clientX, e.clientY);
        if (target) {
          // Eğer fare mevcut aktif toolbar hedefinin içinde kalmaya devam ediyorsa hedefi değiştirme
          if (activeToolbarTarget && activeToolbarTarget.contains(target) && target !== activeToolbarTarget) {
            return;
          }

          if (target !== state.hoveredElement) {
            if (state.hoveredElement) {
              state.hoveredElement.classList.remove("domslider-inspect-hover");
            }
            state.hoveredElement = target;
            state.hoveredElement.classList.add("domslider-inspect-hover");
            showToolbarFor(target);
          }
        }
      },
      true
    );

    // Make elements draggable in edit mode
    document.addEventListener("mousedown", (e) => {
      if (!state.editMode) return;
      const target = getEligibleElementUnder(e.clientX, e.clientY);
      if (target && !isDomSliderNode(target)) {
        target.setAttribute("draggable", "true");
      }
    });

    // Drag start
    document.addEventListener("dragstart", (e) => {
      const target = getEligibleElementUnder(e.clientX, e.clientY) || e.target;
      if (!target || isDomSliderNode(target)) return;

      registerOriginalPosition(target);
      state.draggedElement = target;
      target.classList.add("domslider-dragging");
      e.dataTransfer.setData("text/plain", "domslider-element");
      e.dataTransfer.effectAllowed = "move";
      hideToolbar();
    });

    // Drag over (Calculate flow indicator line to prevent overlap)
    document.addEventListener("dragover", (e) => {
      if (!state.draggedElement) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      // If hovering inside sidebar, sidebar drop zone takes care
      if (e.clientX > window.innerWidth - (state.sidebarOpen ? 380 : 0)) {
        hideDropIndicator();
        dropTargetInfo = null;
        return;
      }

      const target = getEligibleElementUnder(e.clientX, e.clientY);
      if (!target || target === state.draggedElement || target.contains(state.draggedElement)) {
        hideDropIndicator();
        dropTargetInfo = null;
        return;
      }

      const rect = target.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const isBefore = e.clientY < midY;

      dropTargetInfo = {
        targetElement: target,
        position: isBefore ? "before" : "after",
      };

      showDropIndicator(rect, isBefore);
    });

    // Drag end
    document.addEventListener("dragend", (e) => {
      if (state.draggedElement) {
        state.draggedElement.classList.remove("domslider-dragging");
        state.draggedElement.removeAttribute("draggable");
      }
      hideDropIndicator();
      state.draggedElement = null;
      dropTargetInfo = null;
    });

    // Drop on page
    document.addEventListener("drop", (e) => {
      if (!state.draggedElement || !dropTargetInfo) return;
      e.preventDefault();
      const { targetElement, position } = dropTargetInfo;

      // Safe insertion in DOM flow: Avoids absolute positioning & collisions
      const parent = targetElement.parentNode;
      if (!parent) return;

      registerOriginalPosition(state.draggedElement);

      if (position === "before") {
        parent.insertBefore(state.draggedElement, targetElement);
      } else {
        parent.insertBefore(state.draggedElement, targetElement.nextSibling);
      }

      // Sync state and notify UI
      state.draggedElement.classList.remove("domslider-dragging");
      state.draggedElement.removeAttribute("draggable");
      hideDropIndicator();
      state.draggedElement = null;
      dropTargetInfo = null;

      updateModifiedListUI();
      persistCurrentState();
    });

    // Listen for background toggle messages
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === "DOMSLIDER_TOGGLE_SIDEBAR") {
        if (window.__DOMSLIDER_TOGGLE_SIDEBAR__) {
          window.__DOMSLIDER_TOGGLE_SIDEBAR__();
        }
      }
    });
  }

  function getEligibleElementUnder(x, y) {
    const elements = document.elementsFromPoint(x, y);
    for (const el of elements) {
      if (isDomSliderNode(el)) continue;
      // Filter out tiny or root tags
      if (
        el === document.body ||
        el === document.documentElement ||
        el.tagName === "HTML" ||
        el.tagName === "SCRIPT" ||
        el.tagName === "STYLE" ||
        el.tagName === "LINK"
      ) {
        continue;
      }
      return el;
    }
    return null;
  }

  function showDropIndicator(rect, isBefore) {
    if (!dropIndicator) return;
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    dropIndicator.className = "horizontal";
    dropIndicator.style.display = "block";
    dropIndicator.style.width = `${rect.width}px`;
    dropIndicator.style.left = `${rect.left + scrollX}px`;

    const topPos = isBefore ? rect.top : rect.bottom;
    dropIndicator.style.top = `${topPos + scrollY - 2}px`;
  }

  function hideDropIndicator() {
    if (dropIndicator) {
      dropIndicator.style.display = "none";
    }
  }

  // --- Section 3: Individual Reset to Standard Position ---
  function resetElementToOriginal(el) {
    if (!el) return;

    // 1. Unpin if pinned
    if (state.pinnedElements.has(el)) {
      unpinElement(el);
    }

    // 2. Undock if docked
    if (state.dockedElements.has(el)) {
      undockFromSidebar(el);
    }

    // 3. Restore DOM order
    if (state.originalRegistry.has(el)) {
      const { originalParent, originalNextSibling, placeholder } = state.originalRegistry.get(el);
      if (placeholder && placeholder.parentNode) {
        placeholder.parentNode.insertBefore(el, placeholder);
        placeholder.remove();
      } else if (originalParent && originalParent.isConnected) {
        if (originalNextSibling && originalNextSibling.isConnected && originalNextSibling.parentNode === originalParent) {
          originalParent.insertBefore(el, originalNextSibling);
        } else {
          originalParent.appendChild(el);
        }
      }
      state.originalRegistry.delete(el);
    }

    el.classList.remove("domslider-inspect-hover", "domslider-dragging");
    updateModifiedListUI();
    persistCurrentState();
  }

  function resetAllToOriginal() {
    // Copy array to prevent iteration mutation
    const allDocked = Array.from(state.dockedElements.keys());
    allDocked.forEach((el) => resetElementToOriginal(el));

    const allPinned = Array.from(state.pinnedElements.keys());
    allPinned.forEach((el) => resetElementToOriginal(el));

    const allModified = Array.from(state.originalRegistry.keys());
    allModified.forEach((el) => resetElementToOriginal(el));

    // Clear saved storage for this URL
    chrome.storage.local.remove(pageKey());
    updateModifiedListUI();
  }

  // --- Section 4: Pinning to Edge on Scroll ---
  function togglePin(el) {
    if (state.pinnedElements.has(el)) {
      unpinElement(el);
    } else {
      pinElement(el);
    }
    updatePinnedListUI();
    persistCurrentState();
  }

  function pinElement(el) {
    if (!el || state.pinnedElements.has(el)) return;

    registerOriginalPosition(el);

    const rect = el.getBoundingClientRect();
    const originalStyle = {
      position: el.style.position || "",
      top: el.style.top || "",
      left: el.style.left || "",
      width: el.style.width || "",
      zIndex: el.style.zIndex || "",
      boxSizing: el.style.boxSizing || "",
    };

    // Placeholder maintains flow dimensions so page layout won't jump
    const placeholder = document.createElement("div");
    placeholder.className = "domslider-pin-placeholder";
    placeholder.style.width = `${rect.width}px`;
    placeholder.style.height = `${rect.height}px`;
    placeholder.style.margin = window.getComputedStyle(el).margin;
    placeholder.style.display = window.getComputedStyle(el).display === "inline" ? "inline-block" : window.getComputedStyle(el).display;
    placeholder.style.visibility = "hidden";

    el.parentNode.insertBefore(placeholder, el);

    // Lock width so it doesn't deform when fixed
    el.style.width = `${rect.width}px`;
    el.classList.add("domslider-pinned", "domslider-pinned-top");

    state.pinnedElements.set(el, {
      pinType: "top",
      originalStyle,
      placeholder,
      selector: getElementSelector(el),
    });
  }

  function unpinElement(el) {
    const data = state.pinnedElements.get(el);
    if (!data) return;

    el.classList.remove("domslider-pinned", "domslider-pinned-top", "domslider-pinned-bottom");

    // Restore original inline styles
    el.style.position = data.originalStyle.position;
    el.style.top = data.originalStyle.top;
    el.style.left = data.originalStyle.left;
    el.style.width = data.originalStyle.width;
    el.style.zIndex = data.originalStyle.zIndex;
    el.style.boxSizing = data.originalStyle.boxSizing;

    if (data.placeholder && data.placeholder.parentNode) {
      data.placeholder.remove();
    }

    state.pinnedElements.delete(el);
  }

  // --- Section 5: Sidebar Docking ---
  function dockToSidebar(el) {
    if (!el || state.dockedElements.has(el)) return;

    registerOriginalPosition(el);

    // If pinned, unpin first
    if (state.pinnedElements.has(el)) {
      unpinElement(el);
    }

    const dockZone = shadowRoot.querySelector("#sidebar-dock-zone");
    const placeholder = shadowRoot.querySelector("#dock-placeholder");
    if (placeholder) placeholder.style.display = "none";

    // Create wrapper card in sidebar
    const itemCard = document.createElement("div");
    itemCard.className = "dock-item";
    const title = getElementLabel(el);

    itemCard.innerHTML = `
      <div class="dock-item-header">
        <span>${title}</span>
        <div class="item-actions">
          <button class="item-btn btn-return" title="Orijinal yerine geri koy">↺ Geri Döndür</button>
        </div>
      </div>
      <div class="dock-item-content"></div>
    `;

    const contentArea = itemCard.querySelector(".dock-item-content");
    contentArea.appendChild(el);
    dockZone.appendChild(itemCard);

    state.dockedElements.set(el, {
      itemCard,
      title,
      selector: getElementSelector(el),
    });

    itemCard.querySelector(".btn-return").addEventListener("click", () => {
      resetElementToOriginal(el);
    });

    updateDockedCountUI();
    persistCurrentState();
  }

  function undockFromSidebar(el) {
    const data = state.dockedElements.get(el);
    if (!data) return;
    if (data.itemCard && data.itemCard.parentNode) {
      data.itemCard.remove();
    }
    state.dockedElements.delete(el);
    updateDockedCountUI();
  }

  // --- UI Synchronizers ---
  function updateDockedCountUI() {
    const countBadge = shadowRoot.querySelector("#docked-count");
    const placeholder = shadowRoot.querySelector("#dock-placeholder");
    if (countBadge) countBadge.textContent = state.dockedElements.size;
    if (placeholder) {
      placeholder.style.display = state.dockedElements.size === 0 ? "block" : "none";
    }
  }

  function updatePinnedListUI() {
    const list = shadowRoot.querySelector("#pinned-list");
    const badge = shadowRoot.querySelector("#pinned-count");
    if (badge) badge.textContent = state.pinnedElements.size;
    if (!list) return;

    list.innerHTML = "";
    if (state.pinnedElements.size === 0) {
      list.innerHTML = `<div style="color: #64748b; font-size: 12px; padding: 4px;">Henüz pinlenen element yok.</div>`;
      return;
    }

    state.pinnedElements.forEach((data, el) => {
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <span class="list-item-title" title="${getElementLabel(el)}">📌 ${getElementLabel(el)}</span>
        <button class="item-btn" title="Pini Kaldır">✕</button>
      `;
      item.querySelector("button").addEventListener("click", () => {
        unpinElement(el);
        updatePinnedListUI();
        persistCurrentState();
      });
      list.appendChild(item);
    });
  }

  function updateModifiedListUI() {
    updatePinnedListUI();
    updateDockedCountUI();

    const list = shadowRoot.querySelector("#modified-list");
    if (!list) return;

    list.innerHTML = "";
    if (state.originalRegistry.size === 0) {
      list.innerHTML = `<div style="color: #64748b; font-size: 12px; padding: 4px;">Orijinal sıralama korunuyor.</div>`;
      return;
    }

    state.originalRegistry.forEach((data, el) => {
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <span class="list-item-title" title="${getElementLabel(el)}">${getElementLabel(el)}</span>
        <button class="item-btn" title="Standart yerine döndür">↺ Sıfırla</button>
      `;
      item.querySelector("button").addEventListener("click", () => {
        resetElementToOriginal(el);
      });
      list.appendChild(item);
    });
  }

  // --- Section 6: Persistence with chrome.storage.local ---
  function persistCurrentState() {
    try {
      const payload = {
        url: window.location.href,
        updatedAt: Date.now(),
        docked: [],
        pinned: [],
        reordered: [],
      };

      // Docked selectors
      state.dockedElements.forEach((val, el) => {
        const sel = getElementSelector(el) || val.selector;
        if (sel) payload.docked.push(sel);
      });

      // Pinned selectors
      state.pinnedElements.forEach((val, el) => {
        const sel = getElementSelector(el) || val.selector;
        if (sel) payload.pinned.push(sel);
      });

      // Reordered DOM items (save new parent & nextSibling selectors)
      state.originalRegistry.forEach((val, el) => {
        if (state.dockedElements.has(el)) return; // Already in docked
        const selector = getElementSelector(el) || val.selector;
        const parentSelector = getElementSelector(el.parentElement);
        const nextSiblingSelector = getElementSelector(el.nextElementSibling);

        if (selector && parentSelector) {
          payload.reordered.push({
            selector,
            parentSelector,
            nextSiblingSelector,
          });
        }
      });

      const key = pageKey();
      chrome.storage.local.set({ [key]: payload }, () => {
        // saved
      });
    } catch (e) {
      console.warn("DomSlider: Failed to persist layout state", e);
    }
  }

  function restoreSavedState() {
    try {
      const key = pageKey();
      chrome.storage.local.get([key], (result) => {
        const data = result[key];
        if (!data) return;

        // 1. Restore reordered elements
        if (Array.isArray(data.reordered)) {
          data.reordered.forEach((item) => {
            const el = resolveSelector(item.selector);
            const parent = resolveSelector(item.parentSelector);
            const nextSibling = resolveSelector(item.nextSiblingSelector);
            if (el && parent) {
              registerOriginalPosition(el);
              if (nextSibling && nextSibling.parentNode === parent) {
                parent.insertBefore(el, nextSibling);
              } else {
                parent.appendChild(el);
              }
            }
          });
        }

        // 2. Restore pinned elements
        if (Array.isArray(data.pinned)) {
          data.pinned.forEach((sel) => {
            const el = resolveSelector(sel);
            if (el) pinElement(el);
          });
        }

        // 3. Restore docked elements
        if (Array.isArray(data.docked)) {
          data.docked.forEach((sel) => {
            const el = resolveSelector(sel);
            if (el) dockToSidebar(el);
          });
        }

        updateModifiedListUI();
      });
    } catch (e) {
      console.warn("DomSlider: Could not restore saved state", e);
    }
  }

  // --- Bootstrap ---
  function init() {
    initUI();
    setupGlobalEvents();
    restoreSavedState();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

