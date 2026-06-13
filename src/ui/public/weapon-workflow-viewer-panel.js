const openButton = document.getElementById("openWeaponViewerPanelButton");
const closeButton = document.getElementById("closeWeaponViewerPanelButton");
const panel = document.getElementById("weaponViewerWorkflowPanel");
const frame = document.getElementById("weaponViewerWorkflowFrame");

function openWeaponViewerPanel() {
  if (!panel || !frame) {
    return;
  }

  if (!frame.getAttribute("src")) {
    frame.setAttribute("src", frame.dataset.src || "/weapon-viewer.html?embedded=1");
  }

  panel.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeWeaponViewerPanel() {
  if (!panel) {
    return;
  }

  panel.hidden = true;
  document.body.style.overflow = "";
}

openButton?.addEventListener("click", openWeaponViewerPanel);
closeButton?.addEventListener("click", closeWeaponViewerPanel);

panel?.querySelectorAll("[data-close-weapon-viewer]").forEach((element) => {
  element.addEventListener("click", closeWeaponViewerPanel);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && panel && !panel.hidden) {
    closeWeaponViewerPanel();
  }
});
