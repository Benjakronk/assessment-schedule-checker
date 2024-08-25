const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzegX7VaxewvdXyuy8d-VPCyDFhTbkQY0U61XFYubi_QPUmZ4KmgnRBO0bk57tLWtu8/exec';

let scheduleData = [];

async function fetchSchedule() {
    try {
        const response = await fetch(SCRIPT_URL);
        scheduleData = await response.json();
        updateLastUpdated();
    } catch (error) {
        console.error('Error fetching schedule:', error);
        document.getElementById('scheduleContainer').innerHTML = '<p>Error loading schedule. Please try again later.</p>';
    }
}

function displaySchedule(data, searchTerm) {
    const container = document.getElementById('scheduleContainer');
    container.innerHTML = '';

    const resultsText = document.createElement('h2');
    resultsText.textContent = `Viser resultater for ${searchTerm}`;
    container.appendChild(resultsText);

    const infoText = document.createElement('p');
    infoText.textContent = "Hvis du ser noe som ikke stemmer, meld ifra til oss i Teams!";
    infoText.style.fontStyle = 'italic';
    container.appendChild(infoText);

    if (data.length === 0) {
        container.innerHTML += '<p>Ingen vurderinger er lagt inn for denne klassen.</p>';
        return;
    }

    const table = document.createElement('table');
    table.innerHTML = `
        <tr>
            <th>Dato</th>
            <th>Fag</th>
            <th>Beskrivelse</th>
        </tr>
    `;

    const currentDate = new Date();

    data.forEach(item => {
        const assessmentDate = new Date(item.date);
        if (assessmentDate >= currentDate) {
            const row = table.insertRow();
            row.innerHTML = `
                <td>${formatDate(assessmentDate)}</td>
                <td>${item.subject}</td>
                <td>${item.notes}</td>
            `;
        }
    });

    if (table.rows.length === 1) {
        container.innerHTML += '<p>Ingen kommende vurderinger er lagt in for denne klassen.</p>';
    } else {
        container.appendChild(table);
    }
}

function formatDate(date) {
    const days = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];
    const dayName = days[date.getDay()];
    const weekNumber = getWeekNumber(date);
    return `${dayName} ${date.toLocaleDateString('no-NO')} (Uke ${weekNumber})`;
}

function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function searchSchedule() {
    const searchTerm = document.getElementById('classSearch').value.trim().toUpperCase();
    if (searchTerm === '') {
        alert('Please enter a class to search.');
        return;
    }
    const filteredData = scheduleData.filter(item => 
        item.classes.toUpperCase().includes(searchTerm)
    );
    displaySchedule(filteredData, searchTerm);
}

function updateLastUpdated() {
    const now = new Date();
    document.getElementById('lastUpdated').textContent = `Sist oppdatert: ${now.toLocaleString('no-NO')}`;
}

window.onload = fetchSchedule;