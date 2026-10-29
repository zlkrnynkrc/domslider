// Background Service Worker for DomSlider

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "DOMSLIDER_TOGGLE_SIDEBAR" });
  } catch (err) {
    // Content script might not be injected yet
    console.warn("DomSlider: Content script not reachable yet or restricted page", err);
  }
});

