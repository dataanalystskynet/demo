@echo off
title SkyNet Dashboard - keep this window open
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
