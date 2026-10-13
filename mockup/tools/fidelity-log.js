// fidelity_compare.py：app 截圖前讀 fidelity 入口收集的錯誤（null = 入口沒跑起來）
(() => JSON.stringify(window.__fidelityLog === undefined ? null : window.__fidelityLog))()
