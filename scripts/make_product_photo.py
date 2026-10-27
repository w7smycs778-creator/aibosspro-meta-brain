"""Draws a synthetic product photo: a red mug on a light table."""
import sys

from PIL import Image, ImageDraw, ImageFilter

W, H = 640, 480
img = Image.new("RGB", (W, H), (236, 233, 226))
d = ImageDraw.Draw(img)
d.rectangle([0, 330, W, H], fill=(196, 170, 135))  # table
shadow = Image.new("L", (W, H), 0)
ImageDraw.Draw(shadow).ellipse([210, 350, 450, 395], fill=120)
img.paste((120, 100, 80), mask=shadow.filter(ImageFilter.GaussianBlur(12)))
d.rounded_rectangle([230, 170, 410, 370], radius=18, fill=(200, 30, 40))  # body
d.ellipse([230, 155, 410, 190], fill=(150, 20, 30))  # rim
d.arc([380, 215, 470, 320], start=-90, end=90, fill=(200, 30, 40), width=22)  # handle
d.rectangle([255, 200, 275, 340], fill=(230, 80, 90))  # highlight
img.save(sys.argv[1], optimize=True)
