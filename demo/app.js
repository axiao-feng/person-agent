const pages = [...document.querySelectorAll(".page")];
const navItems = [...document.querySelectorAll(".nav-item[data-page]")];
const modal = document.querySelector("#capture-modal");
const toast = document.querySelector("#toast");
let toastTimer;

function showPage(name) {
  const target = document.querySelector(`#page-${name}`);
  if (!target) return;
  pages.forEach((page) => page.classList.toggle("active", page === target));
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.page === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
  history.replaceState(null, "", `#${name}`);
}

function showToast(title, message = "内容已写入本地知识库") {
  toast.querySelector("strong").textContent = title;
  toast.querySelector("p").textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function openCapture(kind = "idea") {
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  const tab = modal.querySelector(`[data-kind="${kind}"]`) || modal.querySelector("[data-kind]");
  tab.click();
  setTimeout(() => document.querySelector("#capture-name").focus(), 80);
}

function closeCapture() {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

navItems.forEach((item) => item.addEventListener("click", () => showPage(item.dataset.page)));
document.querySelectorAll("[data-goto]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.goto)));
document.querySelector("#quick-capture").addEventListener("click", () => openCapture());
document.querySelectorAll("[data-open-capture]").forEach((button) => button.addEventListener("click", () => openCapture(button.dataset.openCapture)));
document.querySelector(".modal-close").addEventListener("click", closeCapture);
document.querySelector(".modal-cancel").addEventListener("click", closeCapture);
modal.addEventListener("click", (event) => { if (event.target === modal) closeCapture(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeCapture();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.querySelector("#global-search").focus();
  }
});

document.querySelectorAll(".capture-tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".capture-tabs button").forEach((item) => item.classList.toggle("active", item === button));
    const placeholders = {
      idea: ["例如：把部分观测建模成后验", "写下背景、下一步或来源…"],
      task: ["例如：补充 S3 消融实验", "预计耗时、截止时间或任务来源…"],
      lecture: ["例如：AI for Science 前沿讲座", "地点、主讲人，以及是否需要汇报…"],
    };
    document.querySelector("#capture-name").placeholder = placeholders[button.dataset.kind][0];
    document.querySelector("#capture-note").placeholder = placeholders[button.dataset.kind][1];
  });
});

document.querySelector("#capture-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const title = document.querySelector("#capture-name").value.trim();
  const kind = document.querySelector(".capture-tabs button.active").textContent;
  closeCapture();
  event.currentTarget.reset();
  showToast(`${kind} 已保存`, title || "内容已写入本地");
});

document.querySelector("#start-focus").addEventListener("click", (event) => {
  event.currentTarget.innerHTML = "专注中 · 89:59";
  event.currentTarget.disabled = true;
  showToast("专注计时已开始", "已为你屏蔽非必要提醒");
});

document.querySelector("#finish-task").addEventListener("click", (event) => {
  const row = event.currentTarget.closest(".timeline-row");
  row.classList.remove("current");
  row.classList.add("done");
  row.querySelector(".tiny-label").textContent = "已完成";
  event.currentTarget.textContent = "✓";
  event.currentTarget.className = "";
  showToast("任务已完成", "今日进度更新为 5 / 6");
});

document.querySelector("#run-digest").addEventListener("click", (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "正在同步 Zotero…";
  setTimeout(() => { button.textContent = "已生成今日知识日报 ✓"; showToast("知识整理完成", "2 篇论文已更新，日报已写入 Obsidian"); }, 1100);
});

document.querySelector("#approve-slot").addEventListener("click", () => {
  const card = document.querySelector("#approval-card");
  card.innerHTML = '<div class="approval-icon">✓</div><div><span class="section-kicker dark">已确认</span><h3>复现实验已安排在周六 14:00–16:00</h3><p>这是 Demo 状态变化；没有写入真实的 Google Calendar。</p></div>';
  card.style.gridTemplateColumns = "42px 1fr";
  showToast("安排已确认", "模拟日历事件已创建");
});
document.querySelector("#dismiss-approval").addEventListener("click", () => {
  document.querySelector("#approval-card").style.display = "none";
  showToast("已暂时搁置", "你可以稍后在任务页重新处理");
});

document.querySelectorAll(".filter-tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".filter-tabs button").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".library-paper").forEach((paper) => paper.classList.toggle("is-hidden", button.dataset.filter !== "all" && paper.dataset.state !== button.dataset.filter));
    const visibleCount = [...document.querySelectorAll(".library-paper")].filter((paper) => !paper.classList.contains("is-hidden")).length;
    document.querySelector("#library-empty").classList.toggle("show", visibleCount === 0);
  });
});

document.querySelectorAll(".read-paper").forEach((button) => {
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "分析中…";
    const paper = button.closest(".library-paper");
    setTimeout(() => {
      paper.dataset.state = "complete";
      paper.querySelector(".paper-state").textContent = "已深读 · 全文";
      paper.querySelector(".paper-state").classList.add("complete");
      button.textContent = "查看卡片 →";
      button.className = "text-btn open-detail";
      button.disabled = false;
      document.querySelector('[data-filter="all"]').click();
      showToast("论文卡片已更新", "已提取研究方向、主要成果和明确不足");
    }, 1200);
  });
});

document.querySelectorAll(".open-detail, .paper-feature").forEach((item) => item.addEventListener("click", () => showToast("论文卡片预览", "研究方向 · 主要成果 · 明确不足")));
document.querySelector("#sync-knowledge").addEventListener("click", (event) => {
  const button = event.currentTarget;
  button.textContent = "同步中…";
  setTimeout(() => { button.textContent = "✓ 已同步"; showToast("Zotero 同步完成", "发现 1 篇新论文（模拟数据）"); }, 900);
});
document.querySelector("#create-index").addEventListener("click", () => showToast("主题索引已生成", "已在 Obsidian 中创建“可控世界模型”索引"));

document.querySelector("#global-search").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.currentTarget.value.trim()) return;
  showPage("knowledge");
  const query = event.currentTarget.value.trim().toLowerCase();
  document.querySelectorAll(".library-paper").forEach((paper) => paper.classList.toggle("is-hidden", !paper.dataset.title.toLowerCase().includes(query)));
  document.querySelector("#library-empty").classList.toggle("show", ![...document.querySelectorAll(".library-paper")].some((paper) => !paper.classList.contains("is-hidden")));
  showToast("搜索完成", `正在显示与“${event.currentTarget.value.trim()}”相关的内容`);
});

showPage(location.hash.slice(1) || "today");
