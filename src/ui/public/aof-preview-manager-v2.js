(() => {
  const SOURCE_IMAGE = "input/cursed_sword_source.png";
  const ACTIVE_MODEL = "input/cursed_sword.glb";
  const ACTIVE_TEXTURE = "output/hunyuan_cursed_sword/baked-texture.png";
  const STEP2_SOURCE_LOCK = "output/hunyuan_cursed_sword/source-lock.png";
  const STEP2_LAYER1 = "output/hunyuan_cursed_sword/layer1.pixel-gradient-step2.png";
  const STEP2_FINAL = "output/hunyuan_cursed_sword/baked-texture.pixel-gradient-step2.png";

  let lastRenderedStep = null;

  function fileUrl(path) {
    return "/api/file?path=" + encodeURIComponent(path) + "&t=" + Date.now();
  }

  function modelUrl() {
    return "/glb-preview.html?path=" + encodeURIComponent(ACTIVE_MODEL) + "&t=" + Date.now();
  }

  function activeStepNumber() {
    const active = document.querySelector(".step-item.active[data-step]");
    if (active) {
      const raw = Number(active.getAttribute("data-step"));
      if (Number.isFinite(raw)) return raw + 1;
    }

    const badge = document.getElementById("currentStepBadge");
    const text = badge ? String(badge.textContent || "") : "";
    const match = text.match(/Step\s+(\d+)\s+of\s+\d+/i);
    if (match) return Number(match[1]);

    return 1;
  }

  function titleForStep(step) {
    if (step === 1) return "Source Image Preview";
    if (step === 2) return "Step 2 Pixel Gradient Preview";
    if (step === 3) return "Download Final Object";
    return "Preview";
  }

  function bodyForStep(step) {
    if (step === 1) {
      return `
        <div class="aof-preview-v2__box">
          <img class="aof-preview-v2__image" src="${fileUrl(SOURCE_IMAGE)}" alt="Source image">
        </div>
        <div class="aof-preview-v2__text">Source: ${SOURCE_IMAGE}</div>
      `;
    }

    if (step === 2) {
      return `
        <div class="aof-preview-v2__step2-grid">
          <div class="aof-preview-v2__step2-tile">
            <div class="aof-preview-v2__tile-title">Source lock</div>
            <img class="aof-preview-v2__img" src="${fileUrl(STEP2_SOURCE_LOCK)}" alt="Source lock">
          </div>
          <div class="aof-preview-v2__step2-tile">
            <div class="aof-preview-v2__tile-title">Layer 1 fill</div>
            <img class="aof-preview-v2__img" src="${fileUrl(STEP2_LAYER1)}" alt="Layer 1 fill">
          </div>
          <div class="aof-preview-v2__step2-tile">
            <div class="aof-preview-v2__tile-title">Final composite</div>
            <img class="aof-preview-v2__img" src="${fileUrl(STEP2_FINAL)}" alt="Final composite">
          </div>
        </div>

        <div class="aof-preview-v2__box aof-preview-v2__box--step2-model">
          <iframe class="aof-preview-v2__iframe" title="Step 2 3D Preview" src="${modelUrl()}"></iframe>
        </div>

        <div class="aof-preview-v2__text">Active Step 2 model: ${ACTIVE_MODEL}</div>
      `;
    }

    if (step === 3) {
      return `
        <div class="aof-download-preview">
          <h2>Download Final Object</h2>
          <p>Objet 3D final généré en Step 2. Aucun atlas, aucune frame, aucun viewer lourd.</p>

          <div class="aof-download-preview__actions">
            <a class="aof-download-preview__button" href="/api/file?path=${encodeURIComponent(ACTIVE_MODEL)}&download=1&filename=cursed_sword.glb" download="cursed_sword.glb">
              Download GLB
            </a>
            <a class="aof-download-preview__button secondary" href="/api/file?path=${encodeURIComponent(ACTIVE_TEXTURE)}&download=1&filename=baked-texture.png" download="baked-texture.png">
              Download texture PNG
            </a>
            <a class="aof-download-preview__button secondary" href="/api/file?path=${encodeURIComponent("output/hunyuan_cursed_sword/textured.pixel-gradient-step2.glb")}&download=1&filename=textured.pixel-gradient-step2.glb" download="textured.pixel-gradient-step2.glb">
              Download Step 2 GLB backup
            </a>
          </div>

          <div class="aof-preview-v2__text">Object: ${ACTIVE_MODEL}</div>
          <div class="aof-preview-v2__text">Texture: ${ACTIVE_TEXTURE}</div>
        </div>
      `;
    }

    return "";
  }

  function render(force = false) {
    const center = document.querySelector(".workflow-center");
    if (!center) return;

    const step = activeStepNumber();

    if (!force && lastRenderedStep === step && center.querySelector("[data-aof-preview-v2='true']")) {
      return;
    }

    lastRenderedStep = step;

    center.innerHTML = `
      <div class="aof-preview-v2" data-aof-preview-v2="true">
        <div class="aof-preview-v2__header">
          <div class="aof-preview-v2__title">${titleForStep(step)}</div>
          <div class="aof-preview-v2__meta">Step ${step} of 3</div>
          <button class="aof-preview-v2__button" type="button" data-aof-preview-v2-reload>Reload Preview</button>
        </div>
        ${bodyForStep(step)}
      </div>
    `;

    const reload = center.querySelector("[data-aof-preview-v2-reload]");
    if (reload) {
      reload.addEventListener("click", () => {
        lastRenderedStep = null;
        render(true);
      });
    }
  }

  function schedule(force = false) {
    window.setTimeout(() => render(force), 30);
  }

  document.addEventListener("DOMContentLoaded", () => schedule(true));
  document.addEventListener("click", () => schedule(false), true);

  window.addEventListener("hashchange", () => schedule(true));
  window.addEventListener("popstate", () => schedule(true));

  schedule(true);
})();
