# Kaizen — osobisty system małych kroków

Codzienny panel oparty na zasadzie małych kroków:

- **Start dnia** — jedno główne zadanie dnia i dwuminutowy mikro-nawyk.
- **Zadania** z priorytetami Muszę / Powinienem / Mogę, rutynami powtarzalnymi i krokami (także z linkami).
- **Bloki skupienia** — Pomodoro z alarmem działającym w tle albo Flow (bez limitu).
- **Punkty za zadania** — Muszę 3 · Powinienem 2 · Mogę 1 · Rutyna 1.
- **Przegląd tygodnia** — punkty dzień po dniu (słupki według rodzaju zadań), serie głównych zadań i mikro-nawyku, czas skupienia.
- **Tryb prosty / pełny** oraz kalendarz z historią każdego dnia.
Działa offline (localStorage), a po zalogowaniu synchronizuje dane przez Supabase między urządzeniami.

**Stack:** Vite + vanilla JS · Supabase (Auth magic link + Postgres z RLS) · hosting Vercel.

## Uruchomienie lokalne

```bash
npm install
cp .env.example .env   # uzupełnij klucze Supabase (bez nich działa tryb lokalny)
npm run dev
```

## Wdrożenie

### 1. Supabase
1. Utwórz projekt na [supabase.com](https://supabase.com).
2. **SQL Editor** → wklej zawartość [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
3. **Authentication → URL Configuration**:
   - *Site URL*: adres z Vercela, np. `https://kaizen-alpha-rouge.vercel.app`
   - *Redirect URLs*: dodaj ten sam adres oraz `http://localhost:5173` (do pracy lokalnej).
4. **Project Settings → API**: skopiuj *Project URL* i klucz *anon / publishable*.

### 2. GitHub
Utwórz puste repo (bez README) i wypchnij kod:

```bash
git remote add origin https://github.com/darek3444/Kaizen.git
git push -u origin main
```

### 3. Vercel
1. **Add New → Project** → zaimportuj repo z GitHuba (framework wykryje się jako *Vite*).
2. **Environment Variables**:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. **Deploy**. Każdy push na `main` wdraża się automatycznie.

> Klucz *anon* jest publiczny z założenia — dane chroni Row Level Security (każdy widzi tylko swoje wiersze). Nigdy nie wstawiaj tu klucza `service_role`.

## Przeniesienie danych ze starego pliku HTML

Stara wersja trzymała dane w localStorage przeglądarki dla pliku `system-kaizen.html`.

1. Otwórz stary plik w tej samej przeglądarce, w której go używałeś.
2. Otwórz konsolę (⌥⌘J w Chrome, ⌥⌘C w Safari) i wklej:

   ```js
   const d = {}; ['daily-log','tasks','config'].forEach(k => d[k] = JSON.parse(localStorage['kz:'+k] || 'null'));
   const a = document.createElement('a');
   a.href = URL.createObjectURL(new Blob([JSON.stringify(d)], {type:'application/json'}));
   a.download = 'kaizen-stare-dane.json'; a.click();
   ```
3. W nowej aplikacji kliknij **Import** w stopce i wybierz pobrany plik.

## Struktura

```
index.html            markup
src/main.js           logika aplikacji
src/store.js          warstwa danych: localStorage + synchronizacja z Supabase
src/supabase.js       klient Supabase (null bez zmiennych env → tryb lokalny)
src/style.css         style (jasny i ciemny motyw)
supabase/schema.sql   tabela kv_store + polityki RLS
public/               ikona i manifest PWA
```
