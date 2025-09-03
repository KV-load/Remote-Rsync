code() {
    FILE="$1"
    # If it's not an absolute path, expand it relative to the current working dir
    case "$FILE" in
        /*) ABS="$FILE" ;;  # already absolute
        *)  ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")" ;;
    esac
    
    SIZE=$(stat -c%s "$ABS" 2>/dev/null )
    # checking which python to use
    if command -v python3.12 &> /dev/null; then
        PYTHON_CMD="python3.12"
    elif command -v python3 &> /dev/null; then
        PYTHON_CMD="python3"
    elif command -v python &> /dev/null; then
        PYTHON_CMD="python"
    else
        echo "Error: Neither python3 nor python is installed." >&2
        return 1
    fi

    "$PYTHON_CMD" - "$ABS" "$SIZE"  <<'PYEND'
import os, socket, sys

def findroot(path):
    markers = ["CMakeLists.txt" , ".git", "pyproject.toml", "setup.py", "requirements.txt", "package.json", "setup.cfg"]
    current = os.path.abspath(os.path.dirname(path))
    while True:
        if any(os.path.exists(os.path.join(current, m)) for m in markers):
            return current
        parent = os.path.dirname(current)
        if parent == current:  # reached filesystem root
            return None
        current = parent

file_path = sys.argv[1]
root_dir = findroot(file_path)

s = socket.socket()
s.connect(("localhost", VS_PORT))   # VS_PORT from env

if root_dir:
    msg = root_dir + "::" + file_path + "@" + sys.argv[2]+ "\n"
else:
    msg = file_path + "@" + sys.argv[2] + "\n"

s.send(msg.encode())
s.close()
PYEND
}
