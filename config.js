// FILE: config.js
// Global configuration for ADCA Quiz System (served from GitHub Pages).
// Keep these values consistent with backend.gs script properties.

window.ADCA = {
  // Apps Script Web App endpoint (आपका final deployed /exec URL)
  // **बिलकुल इस तरह रखें — बिना अतिरिक्त 'ENDPOINT:' text के।**
  ENDPOINT: "https://script.google.com/macros/s/AKfycbxiQK2dwe-sAQLQZfyz8skiTmzaA6s_S9pDLJZPh75NhRg8zYnmCN9I1YkB5xejptjC/exec",

  // Must match backend SCRIPT_PROPS.PRIMARY_KEY & ADMIN_KEY
  PRIMARY_KEY: "primary_Ea7f4c2b",
  ADMIN_KEY: "admin_Zk3q9p8X",

  // Client-side configuration (safe defaults)
  USE_SHEET_QUESTIONS: true,
  TOKEN_TTL_SEC: 600,
  DUP_WINDOW_MIN: 3
};
