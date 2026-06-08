import argparse
import os

from PIL import Image
from PyPDF2 import PdfReader, PdfWriter
from pypinyin import Style, pinyin
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from tqdm import tqdm

# ============================================================
# Offline PDF builder (standalone,离线兜底).
# Scans library/<category>/, sorts (English alphabetical, then
# Chinese by pinyin), scales each image onto a letter page,
# pads odd-page songs for two-page spreads, bookmarks per song.
# Run from the repo root (paths below are CWD-relative):
#   uv run --with PyPDF2,reportlab,tqdm,pypinyin,Pillow \
#     scripts/get_pdf.py strumming | fingerstyle
# ============================================================

IMAGE_EXTS = ('.png', '.jpg', '.jpeg', '.gif', '.jfif', '.webp')

CATEGORIES = {
    'strumming': ('library/strumming', 'output/吉他谱（弹唱）.pdf'),
    'fingerstyle': ('library/fingerstyle', 'output/吉他谱（指弹）.pdf'),
}


def get_pinyin_sort_key(s):
    return ''.join([char[0] for char in pinyin(s, style=Style.NORMAL)])


def list_song_images(folder_path):
    # Only direct children; ignores versions/ and other subdirectories
    return [
        f for f in sorted(os.listdir(folder_path))
        if f.lower().endswith(IMAGE_EXTS)
    ]


def create_pdf_with_bookmarks(root_dir, output_pdf):
    c = canvas.Canvas(output_pdf, pagesize=letter)
    bookmarks = []
    page_num = 1

    folder_names = [
        name for name in os.listdir(root_dir)
        if os.path.isdir(os.path.join(root_dir, name)) and name != 'archive'
    ]
    english_folders = sorted([n for n in folder_names if n[0].isascii()])
    chinese_folders = sorted(
        [n for n in folder_names if not n[0].isascii()],
        key=get_pinyin_sort_key,
    )
    sorted_folders = english_folders + chinese_folders

    for folder_name in tqdm(sorted_folders):
        folder_path = os.path.join(root_dir, folder_name)
        images = list_song_images(folder_path)
        if not images:
            continue

        bookmarks.append((folder_name, page_num))

        for img_file in images:
            img_path = os.path.join(folder_path, img_file)
            with Image.open(img_path) as img:
                img = img.convert('RGB')

                img_width, img_height = img.size
                page_width, page_height = letter

                img_aspect = img_width / img_height
                page_aspect = page_width / page_height

                if img_aspect > page_aspect:
                    new_width = page_width
                    new_height = page_width / img_aspect
                else:
                    new_height = page_height
                    new_width = page_height * img_aspect

                c.drawImage(
                    img_path,
                    (page_width - new_width) / 2,
                    (page_height - new_height) / 2,
                    width=new_width,
                    height=new_height,
                    preserveAspectRatio=True,
                    anchor='c',
                )
                c.showPage()
                page_num += 1

        # ------------------------------------------------------------
        # Pad odd-page songs with a blank page so every song starts on
        # the same side in two-page spread mode
        # ------------------------------------------------------------
        if len(images) % 2 == 1:
            c.showPage()
            page_num += 1

    c.save()

    # Write bookmarks with PyPDF2
    reader = PdfReader(output_pdf)
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    for title, num in bookmarks:
        writer.add_outline_item(title, num - 1)

    with open(output_pdf, 'wb') as f:
        writer.write(f)

    print(f'生成完成：{output_pdf}（共 {page_num - 1} 页，{len(bookmarks)} 首）')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='图片谱合成带书签 PDF')
    parser.add_argument(
        'category',
        choices=CATEGORIES.keys(),
        help='strumming=弹唱 / fingerstyle=指弹',
    )
    args = parser.parse_args()

    root_dir, output_pdf = CATEGORIES[args.category]
    os.makedirs(os.path.dirname(output_pdf), exist_ok=True)
    create_pdf_with_bookmarks(root_dir, output_pdf)
