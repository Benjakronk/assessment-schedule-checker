const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzegX7VaxewvdXyuy8d-VPCyDFhTbkQY0U61XFYubi_QPUmZ4KmgnRBO0bk57tLWtu8/exec';

let scheduleData = [];
let filteredData = [];

// Thematic colors for months
const monthColors = {
    0: "#8ecae6",  // January - Winter blue
    1: "#a8dadc",  // February - Light blue
    2: "#b5e48c",  // March - Spring green
    3: "#d9ed92",  // April - Light green
    4: "#99d98c",  // May - Fresh green
    5: "#ffd166",  // June - Summer yellow
    6: "#f9c74f",  // July - Warm yellow
    7: "#f9844a",  // August - Orange
    8: "#f3722c",  // September - Dark orange
    9: "#f8961e",  // October - Autumn orange
    10: "#577590", // November - Deep blue
    11: "#4d908e"  // December - Teal
};

async function fetchSchedule() {
    try {
        const response = await fetch(SCRIPT_URL);
        scheduleData = await response.json();
        updateLastUpdated();
        initializeDateFilters();
    } catch (error) {
        console.error('Feil ved henting av timeplan:', error);
        document.getElementById('calendar').innerHTML = '<p>Feil ved lasting av timeplan. Vennligst prøv igjen senere.</p>';
    }
}

function initializeDateFilters() {
    const today = new Date();
    const oneMonthLater = new Date(today.getFullYear(), today.getMonth() + 1, today.getDate());
    
    document.getElementById('startDate').valueAsDate = today;
    document.getElementById('endDate').valueAsDate = oneMonthLater;
}

function searchSchedule() {
    const searchTerm = document.getElementById('classSearch').value.trim().toUpperCase();
    if (searchTerm === '') {
        alert('Vennligst skriv inn en klasse å søke etter.');
        return;
    }
    filteredData = scheduleData.filter(item => 
        item.classes.toUpperCase().includes(searchTerm)
    );
    updateSearchResultDisplay(searchTerm);
    filterDates();
}

function updateSearchResultDisplay(searchTerm) {
    let resultDisplay = document.getElementById('searchResultDisplay');
    if (!resultDisplay) {
        resultDisplay = document.createElement('h2');
        resultDisplay.id = 'searchResultDisplay';
        resultDisplay.style.cssText = `
            text-align: center;
            margin-bottom: 10px;
        `;
        const calendarElement = document.getElementById('calendar');
        calendarElement.insertBefore(resultDisplay, calendarElement.firstChild);
    }
    resultDisplay.textContent = `Viser resultater for ${searchTerm}`;
}

function filterDates() {
    const startDate = new Date(document.getElementById('startDate').value);
    const endDate = new Date(document.getElementById('endDate').value);
    endDate.setHours(23, 59, 59); // Set to end of day

    const dateFilteredData = filteredData.filter(item => {
        const itemDate = new Date(item.date);
        return itemDate >= startDate && itemDate <= endDate;
    });

    displayCalendar(dateFilteredData, startDate, endDate);
}

function displayCalendar(data, startDate, endDate) {
    let calendarContainer = document.getElementById('calendarContainer');
    if (!calendarContainer) {
        calendarContainer = document.createElement('div');
        calendarContainer.id = 'calendarContainer';
        calendarContainer.style.cssText = `
            max-height: 600px;
            overflow-y: auto;
            border: 1px solid #ccc;
            padding: 10px;
            margin: 0 auto;
            width: 90%;
            max-width: 800px;
        `;
        document.getElementById('calendar').appendChild(calendarContainer);
    }
    calendarContainer.innerHTML = '';

    let currentDate = new Date(startDate);
    currentDate.setDate(1); // Start from the first day of the month

    while (currentDate <= endDate) {
        const monthTable = createMonthTable(currentDate, data);
        calendarContainer.appendChild(monthTable);
        currentDate.setMonth(currentDate.getMonth() + 1);
    }
}

function createMonthTable(date, data) {
    const monthContainer = document.createElement('div');
    monthContainer.className = 'month-container';
    monthContainer.style.backgroundColor = monthColors[date.getMonth()];

    const monthHeader = document.createElement('h2');
    monthHeader.textContent = capitalizeFirstLetter(date.toLocaleString('no', { month: 'long', year: 'numeric' }));
    monthHeader.style.textAlign = 'center';
    monthContainer.appendChild(monthHeader);

    const table = document.createElement('table');
    table.className = 'month-table';
    table.style.width = '100%';

    // Create header row
    const headerRow = table.insertRow();
    headerRow.innerHTML = '<th>Uke</th><th>Man</th><th>Tir</th><th>Ons</th><th>Tor</th><th>Fre</th><th>Lør</th><th>Søn</th>';

    let currentDate = new Date(date.getFullYear(), date.getMonth(), 1);
    let startingDayOfWeek = currentDate.getDay() || 7; // Convert Sunday (0) to 7
    currentDate.setDate(currentDate.getDate() - startingDayOfWeek + 1); // Start from Monday of the first week

    const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const weeksToRender = Math.ceil((lastDayOfMonth + startingDayOfWeek - 1) / 7);

    for (let week = 0; week < weeksToRender; week++) {
        const row = table.insertRow();
        const weekCell = row.insertCell();
        weekCell.textContent = getWeekNumber(currentDate);
        weekCell.className = 'week-number';

        for (let day = 0; day < 7; day++) {
            const cell = row.insertCell();
            cell.textContent = currentDate.getDate();

            if (currentDate.getMonth() === date.getMonth()) {
                cell.className = 'current-month';
                const cellDate = new Date(currentDate.getTime());
                const assessments = data.filter(item => {
                    const itemDate = new Date(item.date);
                    return itemDate.toDateString() === cellDate.toDateString();
                });

                if (assessments.length > 0) {
                    cell.classList.add('has-assessments');
                    cell.addEventListener('click', () => showAssessmentDetails(assessments, cellDate));
                }
            } else {
                cell.className = 'other-month';
            }

            currentDate.setDate(currentDate.getDate() + 1);
        }
    }

    monthContainer.appendChild(table);
    return monthContainer;
}

function showAssessmentDetails(assessments, date) {
    const popup = document.getElementById('popup');
    const popupContent = document.getElementById('popupContent');
    
    popupContent.innerHTML = `<h2>Vurderinger for ${formatDateDetailed(date)}</h2>`;

    const table = document.createElement('table');
    table.innerHTML = `
        <tr>
            <th>Fag</th>
            <th>Beskrivelse</th>
        </tr>
    `;

    assessments.forEach(item => {
        const row = table.insertRow();
        row.innerHTML = `
            <td>${item.subject}</td>
            <td>${item.notes}</td>
        `;
    });

    popupContent.appendChild(table);
    popup.style.display = 'block';

    const closeButton = document.getElementsByClassName('close')[0];
    closeButton.onclick = function() {
        popup.style.display = 'none';
    }

    window.onclick = function(event) {
        if (event.target == popup) {
            popup.style.display = 'none';
        }
    }
}

function formatDateDetailed(date) {
    const days = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];
    const dayName = days[date.getDay()];
    const weekNumber = getWeekNumber(date);
    return `${dayName} ${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()} (Uke ${weekNumber})`;
}

function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function updateLastUpdated() {
    const now = new Date();
    document.getElementById('lastUpdated').textContent = `Sist oppdatert: ${now.toLocaleString('no')}`;
}

function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

window.onload = fetchSchedule;