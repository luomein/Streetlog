"use strict";

window.streetlogLanguage = (() => {
  const messages = {
  "web.layers": {
    "en": "Categories",
    "zh-Hant": "分類"
  },
  "web.push_to_github": {
    "en": "Push to GitHub",
    "zh-Hant": "上傳協作平台"
  },
  "shared.uncategorized": {
    "en": "Uncategorized",
    "zh-Hant": "未分類"
  },
  "web.unsaved_outing": {
    "en": "Unsaved outing",
    "zh-Hant": "未存檔"
  }
};
  const storageKey = "streetlog.language";
  const supported = value => value === "en" || value === "zh-Hant";
  let saved;
  try {
    saved = localStorage.getItem(storageKey);
  } catch {
    // The language can still be changed for this visit.
  }
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  const detect = () => {
    for (const language of preferred) {
      if (/^zh(?:$|-(?:hant|tw|hk|mo)(?:-|$))/i.test(language)) return "zh-Hant";
      if (/^en(?:-|$)/i.test(language)) return "en";
    }
    return "en";
  };
  let current = supported(saved) ? saved : detect();
  const t = (key, english) => messages[key]?.[current] || messages[key]?.en || english;
  const picker = document.getElementById("site-language");

  function updatePage() {
    document.documentElement.lang = current;
    picker.value = current;
    for (const element of document.querySelectorAll("[data-translation]")) {
      element.textContent = t(element.dataset.translation, element.textContent);
      element.lang = current;
    }
  }

  picker.addEventListener("change", () => {
    if (!supported(picker.value)) return;
    current = picker.value;
    try {
      localStorage.setItem(storageKey, current);
    } catch {
      // The current choice still applies.
    }
    updatePage();
    document.dispatchEvent(new Event("streetlog-language-change"));
  });
  updatePage();
  return { t, get current() { return current; } };
})();
