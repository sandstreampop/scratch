"""Step 4: build the layered depth image.
Inputs: work/plate.jpg, work/depth.npy (inverse depth 0 far..1 near), work/seg.npy
Outputs: assets/L{k}.jpg (colour), assets/L{k}.png (R=alpha, GB=16-bit band depth), assets/water.png, assets/scene.json
Each layer = a depth band. Colour behind nearer layers is filled with a push-pull fill, so the
layer keeps going behind whatever is in front of it and the camera can move past."""
import numpy as np, json, cv2
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter, binary_dilation

MARGIN = 0.10           # extend the picture beyond the frame so a sideways glance doesn't fall off the edge
BANDS = [               # (name, d_min, d_max)  d = inverse depth, 1 = nearest
    ('sky',   -1.00, 0.015),
    ('far',    0.015, 0.28),
    ('water',  0.28, 0.47),
    ('bank',   0.47, 0.66),
    ('cliff',  0.66, 0.82),
    ('fore',   0.82, 1.01),
]
MAX_TEX = 2048
ZNEAR, ZFAR, STRETCH_MAX = 4.0, 400.0, 20.0
REACH = {1:420, 2:300, 3:220, 4:170, 5:140}   # px a layer keeps going behind nearer content before giving way to the layer behind   # must match index.html

plate = np.asarray(Image.open('work/plate.jpg').convert('RGB')).astype(np.float32)/255
depth = np.load('work/depth_sharp.npy').astype(np.float32)
seg   = np.load('work/seg.npy')
labels= {v:int(k) for k,v in json.load(open('work/ade_labels.json')).items()}
INSET = 6               # drop the frame-shadow pixels at the very edge of the plate
plate, depth, seg = plate[INSET:-INSET, INSET:-INSET], depth[INSET:-INSET, INSET:-INSET], seg[INSET:-INSET, INSET:-INSET]
H, W  = depth.shape

# --- semantic fixes: sky is far; soften the boundary so the silhouette feather lands in the sky band
sky = seg==labels['sky']
sky = cv2.morphologyEx(sky.astype(np.uint8), cv2.MORPH_OPEN, np.ones((9,9),np.uint8)).astype(bool)
depth = np.where(sky, 0.0, depth)

# --- water mask: hand polygon in plate coords, only the pale water (boats/figures are darker)
water_poly = [(x-INSET,y-INSET) for x,y in [(600,1290),(800,1278),(860,1340),(920,1420),(900,1500),(960,1525),(960,1565),
              (800,1575),(690,1545),(560,1515),(470,1525),(410,1480),(500,1425),(560,1420),(620,1335)]]
wm = Image.new('L',(W,H),0); ImageDraw.Draw(wm).polygon(water_poly, fill=255)
water = (np.asarray(wm)>0) & (plate.mean(2)>0.40)
water = cv2.morphologyEx(water.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((7,7),np.uint8))
water = gaussian_filter(water.astype(np.float32), 3.0)

# --- extend everything by MARGIN (edge replicate + blur so the frame edge isn't a hard stop)
mx, my = int(W*MARGIN), int(H*MARGIN)
HAZE = np.array([0.36, 0.33, 0.28], np.float32)   # what lies beyond the margin; must match world.background in index.html
def extend(a, blur):
    e = np.pad(a, ((my,my),(mx,mx)) + (((0,0),) if a.ndim==3 else ()), mode='edge')
    if blur:
        b = gaussian_filter(e, (blur,blur,0) if e.ndim==3 else blur)
        core = np.zeros(e.shape[:2], bool); core[my:my+H, mx:mx+W] = True
        ramp = gaussian_filter(core.astype(np.float32), 12)[...,None] if e.ndim==3 else gaussian_filter(core.astype(np.float32),12)
        e = e*ramp + b*(1-ramp)
        if e.ndim==3:   # fade the outer half of the margin into the haze colour
            dist = cv2.distanceTransform((~core).astype(np.uint8), cv2.DIST_L2, 5)
            w = np.clip((dist - 0.45*min(mx,my))/(0.5*min(mx,my)), 0, 1)[...,None]
            e = e*(1-w) + HAZE*w
    return e
plate = extend(plate, 22); depth = extend(depth, 4); water = extend(water, 0)
EH, EW = depth.shape
print('extended plate', EW, EH)

def push_pull(img, known):
    """Fill unknown pixels with a multi-scale average of known ones (smooth, hole-free)."""
    img = img.astype(np.float32); known = known.astype(np.float32)
    if known.min() > 0: return img
    h, w = known.shape
    if min(h, w) <= 2:
        m = known.sum()
        fill = (img*known[...,None]).sum((0,1))/m if m>0 else np.zeros(img.shape[2])
        return np.where(known[...,None]>0, img, fill)
    k2 = cv2.resize(known, (w//2, h//2), interpolation=cv2.INTER_AREA)
    i2 = cv2.resize(img*known[...,None], (w//2, h//2), interpolation=cv2.INTER_AREA).reshape(h//2, w//2, -1)
    i2 = i2/np.maximum(k2,1e-6)[...,None]
    filled2 = push_pull(i2, k2>1e-6)
    up = cv2.resize(filled2, (w, h), interpolation=cv2.INTER_LINEAR).reshape(h, w, -1)
    kk = np.clip(known,0,1)[...,None]
    return img*kk + up*(1-kk)

layers = []
for k,(name, dmin, dmax) in enumerate(BANDS):
    inband = (depth >= dmin) & (depth < dmax)
    nearer = depth >= dmax
    # alpha: this layer exists wherever the scene is in-band or hidden behind nearer bands.
    # Feather the far boundary (silhouette against farther layers).
    far_edge = np.clip((depth - dmin)/0.02 + 0.5, 0, 1) if k>0 else np.ones_like(depth)
    alpha = np.where(nearer, 1.0, far_edge)
    if k > 0:   # bounded reach behind nearer content; the sky covers everything
        dist = cv2.distanceTransform((~inband).astype(np.uint8), cv2.DIST_L2, 5)
        alpha = np.where(nearer & (dist > REACH[k]), 0.0, alpha)
    # colour: real pixels in band; behind nearer content, mirror the band's own texture across the boundary
    # (keeps brushwork instead of a blur), falling back to a push-pull average further in.
    from scipy.ndimage import binary_erosion
    src = binary_erosion(inband, iterations=2)                   # colour source: safely inside the band
    src |= inband & ~binary_dilation(src, iterations=3)          # but keep thin things (masts, branches, figures)
    known = src
    base = push_pull(plate, known)
    from scipy.ndimage import distance_transform_edt
    dist_k, (iy, ix) = distance_transform_edt(~known, return_indices=True)
    yy, xx = np.indices(known.shape)
    my_ = np.clip(2*iy - yy, 0, EH-1); mx_ = np.clip(2*ix - xx, 0, EW-1)
    mirror_ok = known[my_, mx_] & ~known
    mirrored = plate[my_, mx_]
    wmir = np.clip(1.0 - (dist_k-40)/60.0, 0, 1)[...,None]          # trust the mirror for ~40px, fade to the average by 100px
    col = np.where(known[...,None], plate, mirrored*wmir*mirror_ok[...,None] + base*(1-wmir*mirror_ok[...,None]))
    col = np.where(known[...,None], col, gaussian_filter(col, (1.2,1.2,0)))
    col = np.where((inband & ~known)[...,None], col, col)         # edge ring now carries fill colour, not the other side's
    # depth of this layer's surface: real (clipped) depth wherever the scene is in-band or farther,
    # and a boundary-continuous inpaint where a nearer band hides it.
    dclip = np.clip(depth, max(dmin,0), min(dmax,1))
    lo, hi = max(dmin,0), min(dmax,1)
    d8 = np.round((dclip-lo)/(hi-lo)*255).astype(np.uint8)
    hidden = nearer.astype(np.uint8)*255
    if k == 0:
        dl = np.zeros_like(depth)
    else:
        filled = cv2.inpaint(d8, hidden, 5, cv2.INPAINT_TELEA).astype(np.float32)/255*(hi-lo)+lo
        smooth = gaussian_filter(filled, 4)
        dl = np.where(nearer, smooth, dclip)
    # carve: pixels whose surface would stretch more than STRETCH_MAX x along the view ray are not part of
    # any surface, they are the blurred silhouette. Dropping them opens a clean gap to the layer behind.
    TX = 0.42*(W/H); px_angle = 2*TX/W
    zz = 1.0/((1.0/ZFAR)*(1-dl) + (1.0/ZNEAR)*dl)
    gy, gx = np.gradient(zz)
    stretch = np.hypot(gx, gy)/(zz*px_angle)
    carve = (stretch > STRETCH_MAX)
    carve = binary_dilation(carve, iterations=1)
    alpha = np.where(carve, 0.0, alpha)
    # crop to the layer's bbox
    ys, xs = np.where(alpha > 0.02)
    y0, y1, x0, x1 = max(ys.min()-4,0), min(ys.max()+5,EH), max(xs.min()-4,0), min(xs.max()+5,EW)
    if k == 0: y0,y1,x0,x1 = 0,EH,0,EW
    c = np.clip(col[y0:y1,x0:x1],0,1); a = alpha[y0:y1,x0:x1]; d = dl[y0:y1,x0:x1]; w_ = water[y0:y1,x0:x1]
    layers_dmin, layers_dmax = max(dmin,0), min(dmax,1)
    ch, cw = a.shape
    s = min(1.0, MAX_TEX/max(ch,cw))
    tw, th = int(round(cw*s)), int(round(ch*s))
    rgb = Image.fromarray((c*255).astype(np.uint8)).resize((tw,th), Image.LANCZOS)
    # mask PNG: R = alpha, G/B = 16-bit depth normalised inside the band, A = water
    dn = np.clip((d - layers_dmin)/(layers_dmax - layers_dmin), 0, 1)
    d16 = np.round(dn*65535).astype(np.uint32)
    # opaque RGB on purpose: browsers premultiply PNG alpha on decode and would destroy the depth bytes
    rgb3 = np.dstack([(a*255).astype(np.uint8), (d16>>8).astype(np.uint8), (d16&255).astype(np.uint8)])
    msk = Image.fromarray(rgb3, 'RGB').resize((tw,th), Image.NEAREST)
    rgb.save(f'assets/L{k}.jpg', quality=88); msk.save(f'assets/L{k}.png', optimize=True)
    layers.append(dict(name=name, dmin=max(dmin,0), dmax=min(dmax,1),
        rect=[x0/EW, y0/EH, (x1-x0)/EW, (y1-y0)/EH], tex=[tw,th]))
    print(f'L{k} {name:6s} band[{dmin:.3f},{dmax:.3f}) bbox x{x0}-{x1} y{y0}-{y1} tex {tw}x{th} inband={inband.mean():.2f}')

def uv(x,y): return [(x-INSET+mx)/EW, (y-INSET+my)/EH]
Image.fromarray((np.clip(water,0,1)*255).astype(np.uint8)).resize((EW//2,EH//2), Image.BILINEAR).save('assets/water.png', optimize=True)
# low-res whole-scene depth for the camera's collision test
Image.fromarray((np.clip(depth,0,1)*255).astype(np.uint8)).resize((EW//4,EH//4), Image.BILINEAR).save('assets/depth_small.png', optimize=True)
scene = dict(
    image=[EW,EH], plate=[W,H], margin=MARGIN, layers=layers,
    sun=uv(770,780),                                   # brightest sky gap
    sway=[dict(c=uv(1045,1050), r=[40/EW,170/EH], amp=0.012, name='pennant'),
          dict(c=uv(740,1250),  r=[60/EW,110/EH], amp=0.006, name='sails')],
    horizon=uv(736,1300)[1],
)
json.dump(scene, open('assets/scene.json','w'), indent=1)
# small debug previews
Image.fromarray((np.clip(plate,0,1)*255).astype(np.uint8)).resize((EW//4,EH//4)).save('work/ext_preview.jpg')
