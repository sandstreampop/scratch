"""Step 2b: snap the depth map's soft silhouettes to the painting's colour edges.
Colour-guided filter (He et al.) at half res, then local min/max snapping across steep gradients.
Writes work/depth_sharp.npy and a before/after preview."""
import numpy as np, cv2
from PIL import Image
from scipy.ndimage import minimum_filter, maximum_filter, uniform_filter

plate = np.asarray(Image.open('work/plate.jpg').convert('RGB')).astype(np.float32)/255
depth = np.load('work/depth.npy').astype(np.float32)
H, W = depth.shape

def guided_filter_color(I, p, r, eps):
    box = lambda a: cv2.boxFilter(a, -1, (2*r+1, 2*r+1), borderType=cv2.BORDER_REFLECT)
    mI = np.dstack([box(I[...,c]) for c in range(3)]); mp = box(p)
    mIp = np.dstack([box(I[...,c]*p) for c in range(3)])
    covIp = mIp - mI*mp[...,None]
    var = np.zeros(I.shape[:2]+(3,3), np.float32)
    for i in range(3):
        for j in range(i,3):
            v = box(I[...,i]*I[...,j]) - mI[...,i]*mI[...,j]; var[...,i,j] = v; var[...,j,i] = v
    var += eps*np.eye(3, dtype=np.float32)
    a = np.linalg.solve(var.reshape(-1,3,3), covIp.reshape(-1,3,1)).reshape(I.shape[:2]+(3,))
    b = mp - (a*mI).sum(-1)
    ma = np.dstack([box(a[...,c]) for c in range(3)]); mb = box(b)
    return ma, mb

s = 2
Is = cv2.resize(plate, (W//s, H//s), interpolation=cv2.INTER_AREA)
ps = cv2.resize(depth, (W//s, H//s), interpolation=cv2.INTER_AREA)
ma, mb = guided_filter_color(Is, ps, r=7, eps=2e-4)
ma = cv2.resize(ma, (W, H), interpolation=cv2.INTER_LINEAR); mb = cv2.resize(mb, (W, H), interpolation=cv2.INTER_LINEAR)
d = (ma*plate).sum(-1) + mb
d = np.clip(d, 0, 1)

# snap: across steep transitions, move each pixel to the nearer or farther side, whichever its colour matches
for it in range(3):
    gy, gx = np.gradient(d); g = np.hypot(gx, gy)
    zone = g > 0.012
    lo = minimum_filter(d, 7); hi = maximum_filter(d, 7)
    # colour of the two sides: mean colour of pixels near local min / local max (approximate with weighted means)
    wlo = np.exp(-((d-lo)/0.03)**2); whi = np.exp(-((d-hi)/0.03)**2)
    clo = np.dstack([uniform_filter(plate[...,c]*wlo, 7)/np.maximum(uniform_filter(wlo,7),1e-4) for c in range(3)])
    chi = np.dstack([uniform_filter(plate[...,c]*whi, 7)/np.maximum(uniform_filter(whi,7),1e-4) for c in range(3)])
    dlo = ((plate-clo)**2).sum(-1); dhi = ((plate-chi)**2).sum(-1)
    snapped = np.where(dlo < dhi, lo, hi)
    d = np.where(zone, snapped, d)
    d = np.where(zone, cv2.medianBlur(d.astype(np.float32), 5), d)   # kill snap speckle
# only trust the guided/snapped result where the original depth had a transition; elsewhere keep the model's depth
from scipy.ndimage import binary_dilation
g0 = np.hypot(*np.gradient(depth))
zone0 = binary_dilation(g0 > 0.005, iterations=4)
d = np.where(zone0, d, depth)
np.save('work/depth_sharp.npy', d.astype(np.float32))
# preview: crop around the canopy edge, before/after
rows=[]
for (y0,y1,x0,x1) in [(450,750,500,900),(1250,1450,350,750),(1050,1300,850,1250)]:
    a=depth[y0:y1,x0:x1]; b=d[y0:y1,x0:x1]; lo_,hi_=np.percentile(a,2),np.percentile(a,98)
    st=lambda v: np.clip((v-lo_)/(hi_-lo_+1e-6),0,1)
    rows.append(np.hstack([st(a), st(b), plate[y0:y1,x0:x1].mean(-1)]))
pv=np.vstack([cv2.resize(r,(1200,300)) for r in rows])
Image.fromarray((pv*255).astype(np.uint8)).save('/tmp/claude-0/-home-user-scratch/aac1a013-a8fe-5ec1-999c-611d56881275/scratchpad/sharpen_preview.png')
gy, gx = np.gradient(d); print('steep fraction before', (np.hypot(*np.gradient(depth))>0.012).mean().round(4), 'after', (np.hypot(gx,gy)>0.012).mean().round(4))
