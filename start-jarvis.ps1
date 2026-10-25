$project = "D:\Sigma batch\Jarvis"

# Start the JARVIS backend.
Start-Process -FilePath "cmd.exe" `
  -ArgumentList '/k', 'cd /d "D:\Sigma batch\Jarvis\services\api" && npm run dev' `
  -WorkingDirectory "$project"

# Allow the backend time to initialize.
Start-Sleep -Seconds 3

# Start the JARVIS frontend.
Start-Process -FilePath "cmd.exe" `
  -ArgumentList '/k', 'cd /d "D:\Sigma batch\Jarvis\apps\web" && npm run dev -- --host 127.0.0.1' `
  -WorkingDirectory "$project"

# Open the dashboard after Vite starts.
Start-Sleep -Seconds 4
Start-Process "http://localhost:5173"
