# IRON MAN Gym Admin

A gym management system with a member-facing Progressive Web App (PWA).

**Stack:** Express 5, EJS, SQLite (`node:sqlite`), and plain CSS with dark and right-to-left layouts.

> **Prototype:** SMS messages are printed to the server console, OTP codes are shown on screen, and fingerprint check-in is simulated. Do not use the demo accounts or sample records for real people.

## Requirements and setup

Use Node.js 22.13 or later.

```bash
npm install
npm run seed       # Create synthetic demo records
npm start          # Open http://localhost:3000
```

Useful commands:

- `npm test` runs the automated tests.
- `npm run seed -- --force` replaces the current database contents with demo data.
- Set `DEMO=0` to hide OTP codes and the simulated fingerprint button.

## Demo accounts

All demo people use generic Arabic labels. Account names and records are synthetic.

| Role and demo name | Login | Password |
|---|---|---|
| Administrator (`مدير تجريبي`) | `admin` | `ironman-admin` |
| Reception (`استقبال تجريبي 1`) | `reception1` | `ironman-desk` |
| Reception (`استقبال تجريبي 2`) | `reception2` | `ironman-desk` |
| Trainer (`مدرب تجريبي 1`) | `trainer1` | `ironman-coach` |
| Trainer (`مدرب تجريبي 2`) | `trainer2` | `ironman-coach` |
| Trainer (`مدرب تجريبي 3`) | `trainer3` | `ironman-coach` |
| Cleaner (`عامل نظافة تجريبي`) | `cleaner` | `ironman-clean` |
| Demo member | `0790000001` | `ironman-member` |

The activation flow can be tried with phone `0790000002`, national ID `9990000002`, and date of birth `2000-01-15`.

## Roles and access

- **Administrator:** Dashboard, members, subscriptions, payments, products, schedules, announcements, plans, staff, imports, and data management.
- **Reception:** Check-in, member records, subscriptions, payments, and shop sales. Financial dashboard totals are hidden.
- **Trainer:** Assigned members, workout programs, templates, and InBody records.
- **Cleaner:** Daily cleaning tasks and their work-time clock.
- **Member:** Their own account, attendance, program, progress, notifications, and the product catalog.

Permissions are enforced on the server in `mw.js`. Members can only access their own records.

## Main behavior

- The gym day starts at 6:00 AM. Activity between midnight and 6:00 AM counts toward the previous day.
- The iron gym is open Saturday through Wednesday from 3:30 PM to 6:00 AM, Thursday from 3:30 PM to 1:00 AM, and Friday from 6:00 PM to 9:00 PM. Hours can be changed in the schedule page.
- Kickboxing classes run from 7:30 PM to 9:00 PM on scheduled class days. The application checks class hours before accepting a check-in.
- A fingerprint event toggles a member between check-in and check-out. The demo button uses the same rules. An open session is capped after five hours.
- Iron gym and kickboxing attendance are tracked separately. Kickboxing allows one visit per day.
- Workout templates can be copied to a member. A member and their trainer can update the member's copy without changing the original template.
- The shop tracks stock and reverses inventory when a sale is cancelled.
- Background notifications cover subscription renewals, schedule changes, classes, inactivity, and other account events.

## Language

The interface supports Arabic and English, with Arabic as the default. The language switch is available on the pages and saved in a browser cookie. English translations are maintained in `locales/en.json`.

## Privacy and local data

- Seed records use generic Arabic demo labels instead of real people's names.
- The SQLite database (`gym.db` and its companion files) is ignored by Git and should stay local. Never commit a database containing real member or staff information.
- The sample CSV uses demo identities. Replace its sample values before importing any records into a real deployment.
- The original Arabic report remains local. The public repository includes a sanitized English version in [`project-report-en.pdf`](project-report-en.pdf).

## Before real deployment

1. Connect an SMS provider and run with `DEMO=0`.
2. Integrate the gym's fingerprint device and test its data flow.
3. Add database migrations and create backups before importing real records.
4. Deploy behind HTTPS, use persistent storage for SQLite, and set a strong `SESSION_SECRET`.
5. Replace all demo credentials and remove sample data before inviting real staff or members.

## Project structure

```text
app.js                 Express app and middleware
core.js                Membership, check-in, balance, and adherence rules
db.js                  SQLite schema and defaults
dates.js               Gym-day and date helpers
schedule.js            Opening hours and schedule exceptions
notify.js              Notifications and SMS integration point
seed.js                Synthetic demo data
routes/                Authentication, staff, member, program, and shop routes
views/                 EJS pages
locales/en.json        English interface translations
data/templates.json    Workout templates
public/                Styles, PWA files, and import sample
project-report-en.pdf  Sanitized English project report
test/                  Automated tests
```
