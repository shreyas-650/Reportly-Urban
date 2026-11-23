export const INITIAL_COMPLAINTS = [
  {
    id: 'RU-2026-1042',
    title: 'Severe Deep Pothole Near Metro Gate 3',
    category: 'potholes',
    categoryName: 'Potholes & Damaged Roads',
    description: 'A deep crater roughly 2.5 feet wide has opened up in the right lane right outside Metro Gate 3. Two two-wheelers skidded yesterday during evening peak traffic.',
    location: 'Outer Ring Road, Opp. Metro Pillar 148',
    ward: 'Ward 7 - Metro Promenade',
    reportedDate: '2026-11-20',
    reportedTime: '08:45 AM',
    status: 'In Progress',
    department: 'Roads & Infrastructure Department',
    assignedOfficer: 'Officer K. Sharma (Executive Engineer)',
    priority: 'High',
    image: 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&w=800&q=80',
    isUserReport: true,
    timeline: [
      {
        stage: 'Submitted',
        title: 'Report Registered',
        date: '20 Nov 2026, 08:45 AM',
        completed: true,
        notes: 'Complaint logged with photographic evidence by citizen.'
      },
      {
        stage: 'Under Review',
        title: 'Municipal Verification',
        date: '20 Nov 2026, 11:20 AM',
        completed: true,
        notes: 'Verified by central triage desk. Severity tagged as High.'
      },
      {
        stage: 'Officer Assigned',
        title: 'Assigned to Ward Engineer',
        date: '21 Nov 2026, 09:30 AM',
        completed: true,
        notes: 'Dispatched to PWD Road Maintenance division for asphalt patch work.'
      },
      {
        stage: 'In Progress',
        title: 'Field Work Underway',
        date: '22 Nov 2026, 02:15 PM',
        completed: true,
        notes: 'Asphalt layering and roller compaction scheduled.'
      },
      {
        stage: 'Resolved',
        title: 'Resolution & Citizen Sign-off',
        date: 'Estimated by 24 Nov 2026',
        completed: false,
        notes: 'Awaiting completion photo and citizen verification.'
      }
    ]
  },
  {
    id: 'RU-2026-1038',
    title: 'Unattended Waste Pile Overflowing on 4th Cross',
    category: 'garbage',
    categoryName: 'Garbage & Waste',
    description: 'Municipal dumpster has been overflowing for 4 consecutive days. Stray animals are scattering plastic waste across the street and blocking the pedestrian walkway.',
    location: '4th Cross Road, Near Community Hall',
    ward: 'Ward 4 - Green Valley',
    reportedDate: '2026-11-19',
    reportedTime: '07:15 AM',
    status: 'Resolved',
    department: 'Solid Waste Management',
    assignedOfficer: 'Officer R. Patil (Ward Health Officer)',
    priority: 'Medium',
    image: 'https://images.unsplash.com/photo-1605600659908-0ef719419d41?auto=format&fit=crop&w=800&q=80',
    completionImage: 'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?auto=format&fit=crop&w=800&q=80',
    isUserReport: true,
    timeline: [
      {
        stage: 'Submitted',
        title: 'Report Registered',
        date: '19 Nov 2026, 07:15 AM',
        completed: true,
        notes: 'Grievance submitted by citizen with street photo.'
      },
      {
        stage: 'Under Review',
        title: 'Municipal Verification',
        date: '19 Nov 2026, 09:00 AM',
        completed: true,
        notes: 'Acknowledged by Solid Waste division.'
      },
      {
        stage: 'Officer Assigned',
        title: 'Sanitation Crew Dispatched',
        date: '19 Nov 2026, 10:45 AM',
        completed: true,
        notes: 'Tipper truck and clearance team assigned.'
      },
      {
        stage: 'In Progress',
        title: 'Waste Removal in Progress',
        date: '19 Nov 2026, 01:00 PM',
        completed: true,
        notes: 'Garbage cleared and bleaching powder sprinkled.'
      },
      {
        stage: 'Resolved',
        title: 'Completed & Cleaned',
        date: '19 Nov 2026, 04:30 PM',
        completed: true,
        notes: 'Site cleaned thoroughly and container sanitized.'
      }
    ]
  },
  {
    id: 'RU-2026-1025',
    title: 'Three Successive Streetlights Out on Lakeview Promenade',
    category: 'streetlights',
    categoryName: 'Broken Streetlights',
    description: 'Poles #22, #23, and #24 on the southern lake perimeter have been dark for a week. The pathway is pitch black and dangerous for women and senior citizens jogging at dusk.',
    location: 'South Lake Promenade, Near Boating Pier',
    ward: 'Ward 15 - Lakeview District',
    reportedDate: '2026-11-18',
    reportedTime: '06:50 PM',
    status: 'Pending',
    department: 'Electrical & Lighting Board',
    assignedOfficer: 'Pending Assignment',
    priority: 'Medium',
    image: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=800&q=80',
    isUserReport: false,
    timeline: [
      {
        stage: 'Submitted',
        title: 'Report Registered',
        date: '18 Nov 2026, 06:50 PM',
        completed: true,
        notes: 'Report received and queued for desk review.'
      },
      {
        stage: 'Under Review',
        title: 'Preliminary Inspection',
        date: '19 Nov 2026, 10:00 AM',
        completed: true,
        notes: 'Under initial queueing for the feeder line electrical audit.'
      },
      {
        stage: 'Officer Assigned',
        title: 'Line Inspector Assignment',
        date: 'Scheduled',
        completed: false,
        notes: 'Awaiting inspector roster assignment.'
      },
      {
        stage: 'In Progress',
        title: 'Bulb & Wiring Repair',
        date: 'Pending',
        completed: false,
        notes: 'Replacement of LED luminaires.'
      },
      {
        stage: 'Resolved',
        title: 'Illumination Restored',
        date: 'Pending',
        completed: false,
        notes: 'Final night verification check.'
      }
    ]
  },
  {
    id: 'RU-2026-1011',
    title: 'Potable Water Main Gushing on Main Street',
    category: 'water_leakage',
    categoryName: 'Water Supply & Leakage',
    description: 'Underground drinking water main cracked beneath the pedestrian walkway. Clean water has been flooding the street since morning, eroding the road base.',
    location: '12th Main Road, Opposite Sector Bank',
    ward: 'Ward 12 - Civic Station',
    reportedDate: '2026-11-21',
    reportedTime: '07:30 AM',
    status: 'In Progress',
    department: 'Water Supply & Sewerage Board',
    assignedOfficer: 'Officer M. Sundaram (Assistant Engineer)',
    priority: 'High',
    image: 'https://images.unsplash.com/photo-1584467735871-8e85353a8413?auto=format&fit=crop&w=800&q=80',
    isUserReport: false,
    timeline: [
      {
        stage: 'Submitted',
        title: 'Report Registered',
        date: '21 Nov 2026, 07:30 AM',
        completed: true,
        notes: 'Citizen flagged high emergency leakage.'
      },
      {
        stage: 'Under Review',
        title: 'Fast-track Dispatch',
        date: '21 Nov 2026, 08:00 AM',
        completed: true,
        notes: 'Upgraded to urgent priority due to clean water loss.'
      },
      {
        stage: 'Officer Assigned',
        title: 'Leak Detection Team Dispatched',
        date: '21 Nov 2026, 08:45 AM',
        completed: true,
        notes: 'Valve isolation team engaged.'
      },
      {
        stage: 'In Progress',
        title: 'Pipe Welding & Replacement',
        date: '21 Nov 2026, 11:30 AM',
        completed: true,
        notes: 'Main valve isolated, replacement pipe section delivered.'
      },
      {
        stage: 'Resolved',
        title: 'Pressure Test & Road Restoration',
        date: 'Expected today',
        completed: false,
        notes: 'Pending final backfilling and pressure calibration.'
      }
    ]
  },
  {
    id: 'RU-2026-0994',
    title: 'Blocked Stormwater Drain Causing Road Flooding',
    category: 'drainage',
    categoryName: 'Drainage & Sewage',
    description: 'Heavy silt and debris has blocked the primary stormwater drain inlet. Even a mild 15-minute shower creates knee-deep water-logging for vehicles and pedestrians.',
    location: 'Sector 8 Market Entrance Road',
    ward: 'Ward 18 - South Extension',
    reportedDate: '2026-11-17',
    reportedTime: '04:10 PM',
    status: 'Resolved',
    department: 'Stormwater & Drainage Division',
    assignedOfficer: 'Officer A. Deshmukh (Sanitary Inspector)',
    priority: 'High',
    image: 'https://images.unsplash.com/photo-1541888946425-d0fbb1861571?auto=format&fit=crop&w=800&q=80',
    completionImage: 'https://images.unsplash.com/photo-1590402494587-44b71d7772f6?auto=format&fit=crop&w=800&q=80',
    isUserReport: true,
    timeline: [
      {
        stage: 'Submitted',
        title: 'Report Registered',
        date: '17 Nov 2026, 04:10 PM',
        completed: true,
        notes: 'Initial citizen grievance logged with geotag.'
      },
      {
        stage: 'Under Review',
        title: 'Ward Verification',
        date: '17 Nov 2026, 05:30 PM',
        completed: true,
        notes: 'Ward engineer verified silt blockage.'
      },
      {
        stage: 'Officer Assigned',
        title: 'Desilting Suction Unit Dispatched',
        date: '18 Nov 2026, 09:00 AM',
        completed: true,
        notes: 'Super-sucker machine deployed to clear culvert.'
      },
      {
        stage: 'In Progress',
        title: 'Culvert Unblocking',
        date: '18 Nov 2026, 11:00 AM',
        completed: true,
        notes: 'Debris extracted and culvert grates cleared.'
      },
      {
        stage: 'Resolved',
        title: 'Flow Restored & Tested',
        date: '18 Nov 2026, 03:45 PM',
        completed: true,
        notes: 'Water drainage flow tested successfully.'
      }
    ]
  },
  {
    id: 'RU-2026-0980',
    title: 'Cracked and Sinking Pedestrian Sidewalk Slabs',
    category: 'public_infrastructure',
    categoryName: 'Public Infrastructure',
    description: 'Concrete pavers have caved in along a 20-meter stretch of the sidewalk outside Government High School. Poses a serious tripping hazard for children and visually impaired commuters.',
    location: 'Station Road, Outside Govt High School',
    ward: 'Ward 1 - North Central',
    reportedDate: '2026-11-15',
    reportedTime: '11:20 AM',
    status: 'In Progress',
    department: 'Public Works Department (PWD)',
    assignedOfficer: 'Officer V. Narayanan (Sub-Divisional Officer)',
    priority: 'Medium',
    image: 'https://images.unsplash.com/photo-1584467735815-f778f274e296?auto=format&fit=crop&w=800&q=80',
    isUserReport: false,
    timeline: [
      {
        stage: 'Submitted',
        title: 'Report Registered',
        date: '15 Nov 2026, 11:20 AM',
        completed: true,
        notes: 'Citizen submitted grievance.'
      },
      {
        stage: 'Under Review',
        title: 'Field Verification',
        date: '16 Nov 2026, 10:15 AM',
        completed: true,
        notes: 'Footpath damage assessed by ward junior engineer.'
      },
      {
        stage: 'Officer Assigned',
        title: 'Contractor Assigned',
        date: '16 Nov 2026, 03:00 PM',
        completed: true,
        notes: 'Work order issued for replacement of paving blocks.'
      },
      {
        stage: 'In Progress',
        title: 'Re-paving in Progress',
        date: '19 Nov 2026, 09:30 AM',
        completed: true,
        notes: 'Damaged slabs removed and base compacted.'
      },
      {
        stage: 'Resolved',
        title: 'Final Handover',
        date: 'Expected in 48 hours',
        completed: false,
        notes: 'Interlocking pavers installation underway.'
      }
    ]
  }
];
