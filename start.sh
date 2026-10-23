#!/bin/bash
echo "============================================================"
echo "  KHOI DONG FACTORY SNMP NETWORK MONITOR"
echo "============================================================"

if ! command -v node &> /dev/null
then
    echo "[LOI] May chu chua cai dat Node.js!"
    echo "Vui long cai dat Node.js (vi du: sudo apt install nodejs)"
    exit 1
fi

echo "Node.js da san sang. Dang khoi dong Web App..."
node server.js
