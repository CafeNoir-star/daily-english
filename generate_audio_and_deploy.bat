@echo off
REM === English Learning Audio Generation + Deploy ===
REM Run this script every Monday morning after the cloud automation generates new corpus
REM
REM Setup Windows Task Scheduler:
REM 1. Open Task Scheduler (taskschd.msc)
REM 2. Create Basic Task -> Name: "English Audio Gen"
REM 3. Trigger: Weekly, Monday, 9:00 AM
REM 4. Action: Start a program -> this .bat file
REM 5. Start in: C:\Users\user\workspace\自建应用

cd /d "C:\Users\user\workspace\自建应用"

echo === Step 1: Generate audio files ===
node generate_audio.js

echo === Step 2: Deploy to cloud ===
REM Deploy is handled by WorkBuddy - the audio files will be included in the next deploy
REM You can also manually trigger deploy from WorkBuddy

echo === Done ===
echo If new audio files were generated, deploy the app to push them to cloud.
pause
