"""Step 2: monocular depth with Depth Anything V2 (Large if it fits, else Small).
Writes work/depth.npy (float, 0=far .. 1=near, relative) and work/depth_preview.png"""
import numpy as np, torch, sys
from PIL import Image
from transformers import pipeline
model = sys.argv[1] if len(sys.argv)>1 else 'depth-anything/Depth-Anything-V2-Large-hf'
im = Image.open('work/plate.jpg').convert('RGB')
pipe = pipeline('depth-estimation', model=model, device=-1)
out = pipe(im)
d = np.asarray(out['predicted_depth'], dtype=np.float32)
if d.ndim==3: d=d[0]
d = (d-d.min())/(d.max()-d.min())      # DA-V2 outputs inverse depth: 1 = near
d = np.asarray(Image.fromarray(d).resize(im.size, Image.BILINEAR))
np.save('work/depth.npy', d)
Image.fromarray((d*255).astype(np.uint8)).save('work/depth_preview.png')
print('depth', d.shape, d.min(), d.max(), model)
