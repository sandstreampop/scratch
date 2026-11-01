"""Step 2: monocular depth with Depth Anything V2 Large, run at two resolutions and with a
horizontal flip, averaged. Writes work/depth.npy (inverse depth, 0 far .. 1 near) and a preview."""
import numpy as np, torch, sys
from PIL import Image, ImageOps
from transformers import AutoImageProcessor, AutoModelForDepthEstimation
name = 'depth-anything/Depth-Anything-V2-Large-hf'
im = Image.open('work/plate.jpg').convert('RGB')
proc = AutoImageProcessor.from_pretrained(name); model = AutoModelForDepthEstimation.from_pretrained(name).eval()
torch.set_num_threads(4)
def run(img, side):
    inputs = proc(images=img, return_tensors='pt', size={'height': side, 'width': side}, keep_aspect_ratio=True, ensure_multiple_of=14)
    with torch.no_grad(): out = model(**inputs).predicted_depth
    d = torch.nn.functional.interpolate(out[None], size=img.size[::-1], mode='bicubic', align_corners=False)[0,0].numpy()
    return d
acc = []
for side in (518, 770):
    for flip in (False, True):
        src = ImageOps.mirror(im) if flip else im
        d = run(src, side)
        if flip: d = d[:, ::-1]
        d = (d - d.min())/(d.max()-d.min())
        acc.append(d); print('done', side, flip, flush=True)
d = np.mean(acc, 0).astype(np.float32)
d = (d-d.min())/(d.max()-d.min())
np.save('work/depth.npy', d)
Image.fromarray((d*255).astype(np.uint8)).save('work/depth_preview.png')
print('depth', d.shape)
