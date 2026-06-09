#!/usr/bin/env python
import argparse
import json
import os
import sys
import traceback
from pathlib import Path

def log(message):
    print("[hunyuan-runner]", message, flush=True)

def parse_args():
    parser = argparse.ArgumentParser(description="Arena Object Forge Hunyuan3D mesh runner")
    parser.add_argument("--source-image", required=True)
    parser.add_argument("--output-mesh", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--weapon-id", default="weapon")
    parser.add_argument("--project-root", default=".")
    parser.add_argument("--model-path", "--model-id", dest="model_path", default=os.environ.get("HUNYUAN3D_MODEL_PATH", "tencent/Hunyuan3D-2mini"))
    parser.add_argument("--subfolder", default=os.environ.get("HUNYUAN3D_SUBFOLDER", "hunyuan3d-dit-v2-mini-turbo"))
    parser.add_argument("--num-steps", type=int, default=int(os.environ.get("HUNYUAN3D_NUM_STEPS", "30")))
    parser.add_argument("--guidance-scale", type=float, default=float(os.environ.get("HUNYUAN3D_GUIDANCE_SCALE", "5.5")))
    parser.add_argument("--device", default=os.environ.get("HUNYUAN3D_DEVICE", "cuda"))
    return parser.parse_args()

def export_mesh(mesh, output_mesh):
    output_mesh = Path(output_mesh)
    output_mesh.parent.mkdir(parents=True, exist_ok=True)

    if isinstance(mesh, (list, tuple)):
        mesh = mesh[0]

    if hasattr(mesh, "export"):
        mesh.export(str(output_mesh))
        return

    try:
        import trimesh
        trimesh.exchange.export.export_mesh(mesh, str(output_mesh))
        return
    except Exception:
        pass

    raise RuntimeError("Unsupported mesh object returned by Hunyuan pipeline: " + repr(type(mesh)))

def main():
    # Some Conda/Git Bash sessions leak SSL_CERT_FILE or REQUESTS_CA_BUNDLE
    # pointing to missing certificate files. Hugging Face/httpx then crashes
    # before downloading anything. Remove only broken paths.
    for key in ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"]:
        value = os.environ.get(key)
        if value and not Path(value).exists():
            log("removing broken env " + key + "=" + value)
            os.environ.pop(key, None)

    args = parse_args()

    project_root = Path(args.project_root).resolve()
    source_image = Path(args.source_image)
    output_mesh = Path(args.output_mesh)
    output_dir = Path(args.output_dir)

    if not source_image.is_absolute():
        source_image = project_root / source_image
    if not output_mesh.is_absolute():
        output_mesh = project_root / output_mesh
    if not output_dir.is_absolute():
        output_dir = project_root / output_dir

    output_dir.mkdir(parents=True, exist_ok=True)

    report_path = output_dir / "hunyuan-runner-report.json"

    report = {
        "weaponId": args.weapon_id,
        "sourceImage": str(source_image),
        "outputMesh": str(output_mesh),
        "outputDir": str(output_dir),
        "modelPath": args.model_path,
        "subfolder": args.subfolder,
        "device": args.device,
        "numSteps": args.num_steps,
        "guidanceScale": args.guidance_scale,
        "status": "started"
    }

    try:
        log("source image: " + str(source_image))
        log("output mesh: " + str(output_mesh))
        log("model path: " + args.model_path)
        log("subfolder: " + str(args.subfolder))
        log("device: " + args.device)

        if not source_image.exists():
            raise FileNotFoundError("source image not found: " + str(source_image))

        import torch
        log("torch: " + str(torch.__version__))
        log("cuda available: " + str(torch.cuda.is_available()))
        if torch.cuda.is_available():
            log("cuda device: " + torch.cuda.get_device_name(0))

        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
        log("hy3dgen import OK")

        load_kwargs = {}
        if args.subfolder:
            load_kwargs["subfolder"] = args.subfolder

        try:
            pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(args.model_path, **load_kwargs)
        except TypeError:
            log("from_pretrained did not accept subfolder, retrying without subfolder")
            pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(args.model_path)

        if args.device == "cuda" and torch.cuda.is_available():
            try:
                moved_pipeline = pipeline.to("cuda")
                if moved_pipeline is not None:
                    pipeline = moved_pipeline
                else:
                    log("pipeline.to(cuda) returned None; keeping original pipeline object")
            except Exception as exc:
                log("pipeline.to(cuda) failed, continuing: " + repr(exc))

        call_kwargs = {
            "image": str(source_image)
        }

        # Different Hunyuan versions accept different optional kwargs.
        # Try richer call first, then fall back to official minimal API.
        try:
            mesh = pipeline(
                **call_kwargs,
                num_inference_steps=args.num_steps,
                guidance_scale=args.guidance_scale
            )[0]
        except TypeError:
            log("pipeline did not accept num_inference_steps/guidance_scale, retrying minimal call")
            mesh = pipeline(image=str(source_image))[0]

        export_mesh(mesh, output_mesh)

        if not output_mesh.exists():
            raise RuntimeError("Hunyuan run finished but output mesh was not created: " + str(output_mesh))

        report["status"] = "ok"
        report["outputMeshSizeBytes"] = output_mesh.stat().st_size
        log("mesh written: " + str(output_mesh))
        log("mesh size bytes: " + str(output_mesh.stat().st_size))

    except Exception as exc:
        report["status"] = "error"
        report["error"] = str(exc)
        report["traceback"] = traceback.format_exc()
        log("ERROR: " + str(exc))
        traceback.print_exc()
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 1

    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
