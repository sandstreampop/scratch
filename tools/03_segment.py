"""Step 3: semantic masks (sky, water, people, boats, trees...) via SegFormer ADE20K."""
import numpy as np, torch, json
from PIL import Image
from transformers import SegformerImageProcessor, SegformerForSemanticSegmentation
name='nvidia/segformer-b4-finetuned-ade-512-512'
im=Image.open('work/plate.jpg').convert('RGB')
proc=SegformerImageProcessor.from_pretrained(name); model=SegformerForSemanticSegmentation.from_pretrained(name).eval()
with torch.no_grad():
    logits=model(**proc(images=im, return_tensors='pt')).logits
up=torch.nn.functional.interpolate(logits, size=im.size[::-1], mode='bilinear', align_corners=False)
seg=up.argmax(1)[0].numpy().astype(np.uint8)
np.save('work/seg.npy', seg)
id2label=model.config.id2label
ids,counts=np.unique(seg, return_counts=True)
print({id2label[int(i)]:int(c) for i,c in sorted(zip(ids,counts), key=lambda t:-t[1])})
# preview
rng=np.random.RandomState(1); pal=rng.randint(0,255,(150,3)).astype(np.uint8)
Image.fromarray(pal[seg]).resize((368,442)).save('/tmp/claude-0/-home-user-scratch/aac1a013-a8fe-5ec1-999c-611d56881275/scratchpad/seg_small.png')
json.dump({int(k):v for k,v in id2label.items()}, open('work/ade_labels.json','w'))
