import requests
from bs4 import BeautifulSoup
import discord
from discord import  Embed
import time
import re
from discord.ext import commands, tasks
import asyncio
import  signal
from collections import defaultdict
import  pandas as p
import json
import os
import matplotlib.pyplot as plt
import PyPDF2
import openai
from pdf2image import convert_from_path
import pytesseract
import quandl
from PIL import Image, ImageDraw, ImageFont
import  imgkit
import feedparser
from io import BytesIO
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from datetime import datetime, timedelta
import logging


logging.basicConfig(level=logging.INFO)

# Ustawienia
url = 'https://biznes.pap.pl/pl/news/listings/1'
discord_token ='OTM0NTc0NTU3NDEzNjcwOTYy.GSH99A.KAC--p0w4kKQ5EtfnmSqK1mq-kgj7xPNYd4sos'
openai.api_key = "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"
# Inicjalizacja bota Discord

intents = discord.Intents.default()
intents.message_content = True
intents.reactions = True
bot = commands.Bot(command_prefix='!', intents=intents)
# Lista przechowująca już wysłane tytuły
seen_titles = []

KEYWORDS = ["Przychody ze sprzedaży", "Zysk netto", "Działania rozwojowe", "Działania strategiczne" ]  # Przykładowe słowa kluczowe
quandl.ApiConfig.api_key = "iXYff5dHixZeK-hLHk3C"

def sanitize_text(text):
    return text.encode('latin-1', 'ignore').decode('latin-1')


def generate_image(rows, company_name, filename="temp_image.png"):
    width = 400
    font_size = 15
    title_font_size = 20  # Ustal większy rozmiar czcionki dla tytułu
    height_per_row = font_size + 5
    title_height = title_font_size + 10  # Wysokość obszaru na tytuł
    total_height = len(rows) * height_per_row + title_height

    image = Image.new("RGB", (width, total_height), "white")
    d = ImageDraw.Draw(image)
    font = ImageFont.truetype("arial.ttf", font_size)
    title_font = ImageFont.truetype("arial.ttf", title_font_size)  # Czcionka dla tytułu

    # Dodawanie tytułu do obrazka
    title_text = f"Statystyki {company_name}"
    title_width = d.textlength(title_text, font=title_font)
    title_position = (width - title_width) / 2, 5
    d.text(title_position, title_text, font=title_font, fill=(0, 0, 0))

    y_offset = title_height
    colors = [(0, 0, 0), (0, 0, 0), (0, 0, 0), (0, 0, 0), (0, 128, 0), (255, 0, 0), (0, 0, 0), (0, 0, 0)]

    for idx, row in enumerate(rows):
        columns = row.split(' | ')
        num_cols = len(columns)
        col_widths = [1.0 / num_cols] * num_cols
        x_offset = 10

        for i, col in enumerate(columns):
            text_color = colors[idx]
            text_width = d.textlength(col, font=font)
            text_height = font_size

            centered_x_offset = x_offset + (col_widths[i] * width - text_width) / 2
            centered_y_offset = y_offset + (font_size - text_height) / 2

            d.text((centered_x_offset, centered_y_offset), col, font=font, fill=text_color)
            x_offset += col_widths[i] * width

        y_offset += font_size + 5


        if row != rows[-1]:
            d.line([(10, y_offset), (x_offset, y_offset)], fill=(0, 0, 0))

    image.save(filename)
    return filename


def try_round(value_str):
    try:
        # Usuwamy potencjalne sufiksy przed konwersją
        clean_value_str = value_str.replace('k', '').replace('m', '')
        number = float(clean_value_str.replace(',', '.'))

        # Zaokrąglanie i dodawanie jednostek
        if number >= 1_000_000:
            rounded_number = round(number / 1_000_000, 2)
            return f"{rounded_number}m"
        elif number >= 1_000:
            rounded_number = round(number / 1_000)
            return f"{rounded_number}k"
        else:
            return str(number)
    except ValueError:
        # Jeśli nie uda się przekształcić, zwróć oryginalny ciąg
        return value_str


@bot.command()
async def stats(ctx, company_name: str):
    url = f'https://www.stockwatch.pl/gpw/{company_name},notowania,wskazniki.aspx'
    response = requests.get(url)

    if response.status_code != 200:
        await ctx.send("Ta nazwa nie jest poprawna, spróbuj innej.")
        return

    soup = BeautifulSoup(response.content, 'html.parser')

    # Sprawdzanie, czy na stronie istnieją rzeczywiste dane o firmie
    test_selector = '#bxcorpvalues > table'
    if not soup.select_one(test_selector):
        await ctx.send("Ta nazwa nie jest poprawna, spróbuj innej.")
        return
    header_modifications = {
        "#bxcorpvalues > table > thead > tr > th:nth-child(3)": "5 dni",
        "#bxcorpvalues > table > thead > tr > th:nth-child(4)": "20 dni"
    }
    # Usuwanie [pln] z odpowiedniego elementu
    selector_to_clean = "#bxcorpvalues > table > tbody > tr:nth-child(9) > td:nth-child(1)"
    element_to_clean = soup.select_one(selector_to_clean)
    if element_to_clean:
        element_to_clean.string = element_to_clean.get_text().replace("[pln]", "").strip()
    for selector, new_text in header_modifications.items():
        header_element = soup.select_one(selector)
        if header_element:
            header_element.string = new_text



    rows_data = []

    # Pobieranie tytułu
    title_selector = '#SWPL > div.CompanyTitle > h1'
    title_element = soup.select_one(title_selector)
    if title_element:
        title_text = title_element.get_text().strip().replace(" - Notowania i wskaźniki finansowe", "")
    else:
        title_text = company_name  # Używamy nazwy firmy jako tytułu, jeśli nie możemy znaleźć tytułu na stronie

    # Dodawanie nagłówka
    header_selector = '#bxcorpvalues > table > thead > tr'
    header_row = soup.select_one(header_selector)
    if header_row:
        header_texts = ' | '.join([th.get_text().strip() for th in header_row.find_all('th')])
        rows_data.append(header_texts)


    # Dodawanie nowych selektorów
    for i in [1, 2, 9, 10, 11, 12]:
        selector = f'#bxcorpvalues > table > tbody > tr:nth-child({i})'
        row = soup.select_one(selector)

        if row:
            # Dla wierszy 10, 11, 12 sprawdzanie, czy słowo kluczowe w pierwszej kolumnie to "obrót"
            if i in [10, 11, 12]:
                keyword_cell = row.find('td')
                if keyword_cell and 'obrót' not in keyword_cell.get_text().strip().lower():
                    rows_data.append("Brak danych")
                    continue

            modified_values = {}

            # Jeśli to wiersz 9, zaokrąglenie konkretnych wartości
            if i == 9:
                special_selectors = [
                    (2, '#bxcorpvalues > table > tbody > tr:nth-child(9) > td:nth-child(2) > span'),
                    (3, '#bxcorpvalues > table > tbody > tr:nth-child(9) > td:nth-child(3) > span'),
                    (4, '#bxcorpvalues > table > tbody > tr:nth-child(9) > td:nth-child(4) > span')
                ]
                for idx, spec_sel in special_selectors:
                    special_value = soup.select_one(spec_sel)
                    if special_value:
                        modified_values[idx] = try_round(special_value.get_text().strip())

            td_texts = []
            for j, td in enumerate(row.find_all('td')):
                if j + 1 in modified_values:
                    td_texts.append(modified_values[j + 1])
                else:
                    td_texts.append(td.get_text().strip())

            rows_data.append(' | '.join(td_texts))
        else:
            rows_data.append(f"Brak danych ")

    image_filename = generate_image(rows_data, title_text)  # Zmieniamy company_name na title_text
    await ctx.send(file=discord.File(image_filename))


def find_keywords_in_pdf(pdf_path):
    with open(pdf_path, 'rb') as file:
        reader = PyPDF2.PdfReader(file)
        pages_with_keywords = []
        for page_num in range(len(reader.pages)):
            text = reader.pages[page_num].extract_text()
            if any(keyword in text for keyword in KEYWORDS):
                pages_with_keywords.append(page_num)
    return pages_with_keywords


def image_to_text(image_path):
    pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
    return pytesseract.image_to_string(image_path, lang='pol')


def generate_description(text):
    response = openai.ChatCompletion.create(
        messages=[
            {"role": "system", "content": "Jesteś asystentem, który analizuje wykresy giełdowe."},
            {"role": "user", "content": text},
        ],
        model="gpt-4",
        temperature=0.5
    )
    return response.choices[0].message['content']





async def send_daily_images():
    logging.info("Attempting to send daily images.")

    # Zakładając, że kanał, na który chcesz wysłać obrazy, ma ID 'YOUR_CHANNEL_ID'
    channel = bot.get_channel(1094855926059630643)
    if channel:
        await fetch_data_as_image(channel)
    else:
        logging.warning(f"Could not find channel with ID {1094855926059630643}.")

@bot.command()
async def pdf(ctx, url: str):
    await ctx.send('Pobieranie pliku PDF...')
    response = requests.get(url)
    with open('temp.pdf', 'wb') as file:
        file.write(response.content)

    pages_with_keywords = find_keywords_in_pdf('temp.pdf')
    for page_num in pages_with_keywords:
        images = convert_from_path('temp.pdf', first_page=page_num + 1, last_page=page_num + 1)
        for image in images:
            image_path = f'page_{page_num}.png'
            image.save(image_path, 'PNG')

            extracted_text = image_to_text(image_path)
            description = generate_description(extracted_text)
            await ctx.send(description)
def get_makro_data():
    data = quandl.get("WIKI/FB", rows=1)  # Pobiera najnowsze dane dla Facebooka z bazy WIKI
    return data




@bot.command(name='makrodata')
async def fetch_makro_data(ctx):
    data = get_makro_data()
    embed = discord.Embed(title="Dane Makroekonomiczne", description="Opis danych...")
    embed.add_field(name="Ostatnia cena zamknięcia Facebooka", value=str(data['Close'].iloc[0]))
    await ctx.send(embed=embed)

# Lista kodów krajów dla przykładu
countries = ["USA", "CAN", "GBR", "AUS", "DEU"]


def get_cpi_data_for_countries():
    data_dict = {}
    for country in countries:
        # Zastąp `FRED/{country}CPIAUCNS` odpowiednim identyfikatorem zestawu danych dla danego kraju
        data = quandl.get(f"FRED/{country}CPIAUCNS", rows=1)
        data_dict[country] = data['Value'].iloc[0]
    return data_dict


@bot.event
async def on_ready():
    print(f'Zalogowano jako {bot.user.name}({bot.user.id})')
   # scheduler = AsyncIOScheduler()
    #scheduler.add_job(send_daily_images, 'cron', hour=17, minute=20)
   # scheduler.start()
    await rss_check_loop()


@bot.command(name='inflacja')
async def fetch_inflation_data(ctx):
    data = get_cpi_data_for_countries()
    embed = discord.Embed(title="Wskaźnik cen konsumpcyjnych (CPI) - Różne kraje",
                          description="Dane z Federal Reserve Economic Data (FRED)")

    for country, value in data.items():
        embed.add_field(name=f"CPI dla {country}", value=str(value))

    await ctx.send(embed=embed)


@bot.command()
async def dane(ctx):
    url = "https://www.biznesradar.pl/statystyka-sesji/"
    response = requests.get(url)
    soup = BeautifulSoup(response.content, 'lxml')

    selectors = ['#stats > table:nth-child(11)', '#stats > table:nth-child(14)']

    # Mapowanie selektorów na kolory dla czwartej kolumny
    color_mapping = {
        '#stats > table:nth-child(11)': (0, 128, 0),  # zielony
        '#stats > table:nth-child(14)': (255, 0, 0)  # czerwony
    }

    for selector in selectors:
        table = soup.select_one(selector)

        # Przetwarzanie danych w tabeli
        rows_data = []
        rows = table.find_all('tr')
        for row in rows:
            columns = row.find_all('td')
            col_data = [col.text.strip() for col in columns]
            rows_data.append(col_data)

        # Obliczanie szerokości kolumn
        max_cols = max(len(row) for row in rows_data)
        col_widths = [max(len(row[i]) if i < len(row) else 0 for row in rows_data) for i in range(max_cols)]
        header = table.find('tr')
        header_data = [col.text.strip() for col in header.find_all('th')]

        # Dodaj nagłówek na początek listy rows_data
        rows_data.insert(0, header_data)

        # Tworzenie obrazka z danymi w tabeli
        font_size = 15
        font = ImageFont.truetype("arial.ttf", font_size)
        image_width = sum(col_widths) * font_size + 50
        image_height = len(rows_data) * (font_size + 5) + 50
        image = Image.new('RGB', (image_width, image_height), color=(255, 255, 255))
        d = ImageDraw.Draw(image)

        y_offset = 10

        # Dodaj linie wertykalne dla kolumn
        x_line_offset = 10
        for width in col_widths[:-1]:  # Pomiń ostatnią kolumnę
            x_line_offset += width * font_size
            d.line([(x_line_offset, 10), (x_line_offset, y_offset + len(rows_data) * (font_size + 5) - 5)],
                   fill=(0, 0, 0))



        for row in rows_data:
            x_offset = 10
            for i in range(max_cols):
                col = row[i] if i < len(row) else ""

                # Ustaw domyślny kolor tekstu na czarny
                text_color = (0, 0, 0)

                # Jeśli aktualnie przetwarzana kolumna to czwarta kolumna, zmień kolor tekstu
                if i == 3:
                    text_color = color_mapping[selector]

                # Obliczanie szerokości i wysokości tekstu
                text_width = d.textlength(col, font=font)
                text_height = font_size  # zakładając, że font_size jest równy wysokości czcionki

                # Obliczanie przesunięcia x i y, aby wyśrodkować tekst w komórce
                centered_x_offset = x_offset + (col_widths[i] * font_size - text_width) / 2
                centered_y_offset = y_offset + (font_size - text_height) / 2

                d.text((centered_x_offset, centered_y_offset), col, font=font, fill=text_color)
                x_offset += col_widths[i] * font_size

            y_offset += font_size + 5

            d.line([(10, 10), (x_offset, 10)], fill=(0, 0, 0))  # Górna linia
            d.line([(10, y_offset), (x_offset, y_offset)], fill=(0, 0, 0))  # Dolna linia
            d.line([(10, 10), (10, y_offset)], fill=(0, 0, 0))  # Lewa linia
            d.line([(x_offset, 10), (x_offset, y_offset)], fill=(0, 0, 0))  # Prawa linia
            if row != rows_data[-1]:
                d.line([(10, y_offset), (x_offset, y_offset)], fill=(0, 0, 0))
        image_path = "temp_image_{}.png".format(selector.split(":")[-1])  # Dla uniknięcia konfliktów nazw
        image.save(image_path)

        # Wysłanie obrazka na Discorda
        await ctx.send(file=discord.File(image_path))

def split_screenshot(screenshot_path, max_height=680, top_crop=50):
    image = Image.open(screenshot_path)
    width, height = image.size
    image_parts = []

    for i, y in enumerate(range(0, height, max_height)):
        if i == 0:  # If it's the first image part, crop the top by top_crop pixels
            cropped_image = image.crop((0, y + top_crop, width, min(y + max_height, height)))
        else:
            cropped_image = image.crop((0, y, width, min(y + max_height, height)))
        cropped_image_path = f"screenshot_part_{y}.png"
        cropped_image.save(cropped_image_path)
        image_parts.append(cropped_image_path)

    return image_parts


def get_all_styles(soup):
    """Pobierz wszystkie zewnętrzne arkusze stylów i zastąp je osadzonymi stylami."""
    for link in soup.find_all("link", rel="stylesheet"):
        css_url = link["href"]
        response = requests.get(css_url)
        if response.status_code == 200:
            new_tag = soup.new_tag("style")
            new_tag.string = response.text
            link.replace_with(new_tag)
    return soup

@bot.command(name="link")
async def link(ctx, url):
    screenshot_path = "screenshot.png"

    # Pobierz zawartość strony
    response = requests.get(url)
    soup = BeautifulSoup(response.content, 'html.parser')

    # Zmień klasę
    element = soup.find(class_='o-article-content')
    if element:
        element['class'] = 'o-article-content2'

        # Pobierz wszystkie zewnętrzne arkusze stylów i zastąp je osadzonymi stylami
        soup = get_all_styles(soup)

        # Użyj imgkit z dodatkowymi opcjami, ale przekazuj całą zawartość strony
        imgkit.from_string(str(soup), screenshot_path)

        # Podziel zrzut ekranu
        screenshot_parts = split_screenshot(screenshot_path)

        #for part_path in screenshot_parts:
            #with open(part_path, "rb") as part_file:
               #await ctx.send(file=discord.File(part_file, part_path))
           #os.remove(part_path)

        #os.remove(screenshot_path)

        # Dodatkowo, jeśli chcesz wysłać tekst:
        text = element.get_text()
        for i in range(0, len(text), 2000):
            await ctx.send(text[i:i + 2000])
    else:
        await ctx.send(f"Nie znaleziono tekstu, spróbuj innym razem.")
# Stałe
RSS_FEED_URL = 'https://biznes.pap.pl/pl/rss/6614'
DEFAULT_CHANNEL_ID = 931444295762853971  # Zastąp prawdziwym ID kanału
SPECIAL_CHANNEL_ID = 931444374808715285
FILE_NAME = 'company_channels.json'

# Wczytywanie mapowań z pliku
def load_from_file():
    try:
        with open(FILE_NAME, 'r') as file:
            return json.load(file)
    except FileNotFoundError:
        return {}

# Zapisywanie mapowań do pliku
def save_to_file():
    with open(FILE_NAME, 'w') as file:
        json.dump(COMPANY_CHANNELS, file)

# Wczytaj dane z pliku przy starcie bota
COMPANY_CHANNELS = load_from_file()
last_sent_link = None


@bot.command(name='mapuj')
async def map_company(ctx, company_name: str):
    COMPANY_CHANNELS[company_name.lower()] = ctx.channel.id
    await ctx.send(f"Zmapowano spółkę '{company_name}' do tego kanału!")
    save_to_file()  # zapisz aktualizacje do pliku



async def rss_check_loop():
    print("Pętla RSS jest uruchamiana!")
    global last_sent_link

    feed = feedparser.parse(RSS_FEED_URL)


    # Dodane sprawdzenie poniżej
    if not feed.entries:
        print("Nie znaleziono wpisów w kanale RSS!")
        return
    entry = feed.entries[0]

    if entry.link != last_sent_link:
        match = re.match(r'^(.*?)\s*\((\d+/[\d]+)\)\s*(.*)$', entry.title)

        if match:
            company_name = match.group(1)
            remaining_text = match.group(3)

            # Przeróbka wiadomości
            modified_message = f"**{company_name}** [{remaining_text}]({entry.link})"

            # Wyświetlanie wiadomości w konsoli
            print(f"Przetworzona wiadomość RSS: {modified_message}")

            embed = discord.Embed(color=discord.Color.green(), description=modified_message)
        else:
            print(f"Wiadomość RSS nie pasuje do wzorca: {entry.title}")
            embed = discord.Embed(color=discord.Color.blue(), description=f"[{entry.title}]({entry.link})")

        if "69" in entry.title.lower() or "69" in entry.summary.lower():
            target_channel_id = SPECIAL_CHANNEL_ID
        else:
            target_channel_id = DEFAULT_CHANNEL_ID
            for company, channel_id in COMPANY_CHANNELS.items():
                if company in entry.title.lower() or company in entry.summary.lower():
                    target_channel_id = channel_id
                    break

        channel = bot.get_channel(target_channel_id)
        if channel:
            await channel.send(embed=embed)
        else:
            print(f"Nie znaleziono kanału o ID {target_channel_id}")
        last_sent_link = entry.link


def split_message(message):
    return [message[i:i+MAX_MESSAGE_LENGTH] for i in range(0, len(message), MAX_MESSAGE_LENGTH)]

MAX_MESSAGE_LENGTH = 1900
EXCEPTIONS = ["CRS", "M4B", "STI", 'ARI', 'GAR', 'GTF', 'ATO', 'MLT', 'BRAS']

def split_message(message):
    return [message[i:i+MAX_MESSAGE_LENGTH] for i in range(0, len(message), MAX_MESSAGE_LENGTH)]
@bot.command()
async def sendd(ctx):
    embed = discord.Embed(
        description=f"adgbh [dddhj](https://www.biznesradar.pl/symbols-rank/)",
        color=discord.Color.blue()  # Kolor osadzenia (opcjonalnie, możesz dostosować według własnych preferencji)
    )
    await ctx.send(embed=embed)

@bot.command(name='p')
async def fetch_data_as_image(ctx):
    versions = [1, 2]

    for version in versions:
        if version == 1:
            url = "https://www.biznesradar.pl/gielda/newconnect,4,1"
        else:
            url = "https://www.biznesradar.pl/gielda/newconnect,4,2"

        response = requests.get(url)
        soup = BeautifulSoup(response.content, 'html.parser')

        table_data = soup.select_one("#right-content > div > table")
        rows = table_data.find_all('tr')[1:1500]

        data = []
        for row in rows:
            value_column = row.select_one('td:nth-child(11) > span')
            if value_column:
                value = int(value_column.text.replace(',', '').replace(' ', '').strip())
                if value >= 10000:
                    cols = row.find_all('td')
                    cols = [ele.text.strip() for ele in cols]
                    row_data = [ele for ele in cols if ele]
                    if not any(exception in " ".join(row_data) for exception in EXCEPTIONS):
                        data.append(row_data)
        data = data[:20]

        headers = ["Profil", "Czas", "Kurs", "Zmiana", "Zmiana%", "Odniesienie", "Otwarcie", "Min", "Max", "Wolumen",
                   "Obrót"]
        # Ukrywanie kolumny "Min"
        hidden_column_index = headers.index("Min")
        headers.pop(hidden_column_index)

        for row in data:
            row.pop(hidden_column_index)

        # Ukrywanie kolumny "Max"
        hidden_column_index = headers.index("Max")
        headers.pop(hidden_column_index)

        for row in data:
            row.pop(hidden_column_index)

        # Ukrywanie kolumny "Min"
        hidden_column_index = headers.index("Odniesienie")
        headers.pop(hidden_column_index)

        for row in data:
            row.pop(hidden_column_index)

        # Ukrywanie kolumny "Max"
        hidden_column_index = headers.index("Otwarcie")
        headers.pop(hidden_column_index)

        for row in data:
            row.pop(hidden_column_index)

        data.insert(0, headers)

        max_columns = max(map(len, data))
        for row in data:
            while len(row) < max_columns:
                row.append("")

        # Po usunięciu niechcianych kolumn
        col_widths = [max(map(len, col)) for col in zip(*data)]

        # Utworzenie obrazu
        font = ImageFont.truetype("arial.ttf", 14)
        img_width = sum(col_widths) * 10 + len(col_widths) * 5  # Update here
        img_height = len(data) * 20  # Update here
        image = Image.new('RGB', (img_width, img_height), color='white')
        d = ImageDraw.Draw(image)

        y_offset = 0  # Update here
        for row in data:
            x_offset = 0  # Update here
            for i, item in enumerate(row):
                d.text((x_offset, y_offset), item, fill='black', font=font)
                x_offset += col_widths[i] * 10 + 5
                d.line([(x_offset - 2, y_offset), (x_offset - 2, y_offset + 19)], fill='black')
            y_offset += 20
            d.line([(0, y_offset - 1), (img_width, y_offset - 1)], fill='black')

        # Dodaj linię po prawej stronie
        d.line([(img_width - 1, 0), (img_width - 1, img_height)], fill='black')

        image_path = f"data_image_4{version}.png"
        image.save(image_path)

        await ctx.send(file=discord.File(image_path))
@bot.command()
async def pakiet(ctx):
    options = {
        'height': '700',  # Ustawia wysokość ekranu na 700 pikseli
        'no-stop-slow-scripts': '',
        'javascript-delay': '2000',
        'load-error-handling': 'ignore'
    }

    imgkit.from_url('https://www.gpw.pl/transakcje-pakietowe', 'screenshot.png', options=options)

    # Wysyłanie zrzutu ekranu na kanał
    await ctx.send(file=discord.File("screenshot.png"))


def fetch_data_and_plot(company_name, page_number):
    # Tworzenie URL na podstawie podanych argumentów
    url = f"https://www.bankier.pl/forum/forum_o_{company_name},6,21,10000001159,{page_number}.html"
    response = requests.get(url)

    # Jeżeli odpowiedź nie jest poprawna, przerwij funkcję
    if response.status_code != 200:
        print(f"Nie udało się pobrać danych dla URL: {url}")
        return

    soup = BeautifulSoup(response.content, 'html.parser')

    # Używamy selektora do znalezienia elementów td z odpowiednimi klasami dla daty
    dates = soup.select("td.createDate.textAlignCenter.textNowrap")

    # Używamy selektora do znalezienia elementów td z odpowiednimi klasami dla liczby postów
    thread_counts = soup.select("td.threadCount.textAlignCenter.textNowrap")

    # Używamy defaultdict do przechowywania licznika postów dla każdej daty
    posts_count_by_date = defaultdict(int)

    # Przechodzimy przez obie listy jednocześnie
    for date, thread_count in zip(dates, thread_counts):
        # Pobieramy tylko datę (bez godziny)
        only_date = date.get_text(strip=True).split()[0]
        count = int(thread_count.get_text(strip=True))
        posts_count_by_date[only_date] += count

    # Wizualizacja danych
    dates = list(posts_count_by_date.keys())
    counts = list(posts_count_by_date.values())

    plt.bar(dates, counts)
    plt.xlabel("Data")
    plt.ylabel("Liczba postów")
    plt.title(f"Liczba postów dla firmy {company_name} na stronie {page_number}")
    plt.xticks(rotation=45)
    plt.tight_layout()
   # plt.show()


# Przykład użycia:
companies = ["milisys"]  # Możesz dodać więcej nazw firm
pages = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]  # Możesz dodać więcej numerów stron

#for company in companies:
    #for page in pages:
       #fetch_data_and_plot(company, page)
# 1. Pobieranie danych
def get_data():
    url = 'https://www.bankier.pl/gielda/kalendarium'
    response = requests.get(url)
    soup = BeautifulSoup(response.content, 'html.parser')

    all_results = []

    for i in range(2, 7):  # Dla głównych selektorów od div:nth-child(2) do div:nth-child(6)
        date_selector = f'#calendarContent > div:nth-child({i}) > div.calendarDayHeader'
        date_text = soup.select_one(date_selector).text.strip()

        base_selector = f'#calendarContent > div:nth-child({i}) > div.calendarDayContent > div'
        children = soup.select(base_selector + '> div')

        results = []

        for index, child in enumerate(children, 1):
            company_selector = f'{base_selector} > div:nth-child({index}) > div.eventHeader > div.eventTitle > div.company'
            description_selector = f'{base_selector} > div:nth-child({index}) > div.eventDescription'

            company = soup.select_one(company_selector)
            description = soup.select_one(description_selector)

            if company and description:
                results.append(f"**{company.text.strip()}** - {description.text.strip()}")

        all_results.append((date_text, results))

    return all_results
async def send_large_message(ctx, content):
    while content:
        # Znajdź ostatni znak nowej linii w ciągu o długości <= 4000
        slice_index = content[:2000].rfind('\n')

        # Jeśli nie znaleziono znaku nowej linii, wysyłamy całą treść
        if slice_index == -1 or len(content) <= 2000:
            slice_index = 2000

        # Wysyłanie części wiadomości
        await ctx.send(content[:slice_index])

        # Usuwanie wysłanej części z zawartości
        content = content[slice_index:].lstrip()

@bot.command()
async def kalendarz(ctx):
    data = get_data()
    separator = '\u200B'  # Zero Width Space

    # Lista kolorów, możesz dostosować według własnych potrzeb
    colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff]

    for index, entry in enumerate(data):
        date, events = entry
        embed_description = f"{separator}\n".join(events)  # Usunęliśmy datę z opisu

        # Wybieranie koloru z listy colors
        color = colors[index % len(colors)]

        embed = discord.Embed(title=date, description=embed_description, color=color)  # Data jako tytuł
        await ctx.send(embed=embed)
bot.run(discord_token)


